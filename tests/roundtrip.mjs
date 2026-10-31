#!/usr/bin/env node
/**
 * tests/roundtrip.mjs
 * -----------------------------------------------------------------------------
 * NCM 解码器「字节级正确性」测试（零依赖，Node >= 18，ESM）。
 *
 * 覆盖：
 *   1. 流式解码：对 fixtures 清单中的每个 .ncm，先读 1MB 前缀 probeHeader
 *      （不足则按 need 扩容），再用块长数组
 *      [1, 3, 255, 256, 257, 4095, 8192, 65536, 1<<20] 逐块
 *      transformInPlace(chunk, keyBox, 绝对offset) 解码整文件，
 *      对结果做 sha256 与 .expected.<ext> 比对。全部块长必须字节一致。
 *      default profile 全量跑；large profile 只跑 65536。
 *   2. 头部解析边界：5/13/20/30 字节截断 → probeHeader complete=false、
 *      need 递增且 > 已读长度、只出现 TRUNCATED；64KB 前缀可成功 probe。
 *   3. 错误处理：BAD_MAGIC / BAD_KEY_LEN / BAD_KEY_PREFIX。
 *   4. 命名：buildOutputName 对中文/emoji/非法字符/超长/metadata=null 的行为。
 *   5. 汇总：PASS/FAIL 数、解码总字节、用时；任一失败 exit 1。
 *
 * 用法：
 *   node tests/roundtrip.mjs
 *
 * 前置：先运行 node tools/make-fixtures.mjs（default 输出到 fixtures/，
 *       large/small 输出到 fixtures-large、fixtures-small 目录即可被自动发现）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  probeHeader,
  parseHeader,
  createDecoder,
  transformInPlace,
  buildOutputName,
  NcmError,
} from '../src/ncm.js';
import { TEST_KEY_BYTES } from '../tools/test-keys.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURES = path.join(ROOT, 'fixtures');

const MB = 1024 * 1024;

/** 要求覆盖的块长（从 1 字节到 1MB，含非 2 的幂，证明「任意块长都正确」） */
const ALL_BLOCK_SIZES = [1, 3, 255, 256, 257, 4095, 8192, 65536, 1 << 20];

// ============================================================================
// 结果统计 / 断言
// ============================================================================

let pass = 0;
let fail = 0;
let bytesDecoded = 0;
/** @type {{name:string, err:Error}[]} */
const failures = [];
const startedAt = Date.now();

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * 执行一个测试项，把 PASS/FAIL 打印到 stdout。
 * @param {string} name
 * @param {() => (string|void)} fn 成功可返回附加信息（PASS 行尾部）
 */
function check(name, fn) {
  try {
    const detail = fn();
    pass++;
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    fail++;
    failures.push({ name, err });
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
  }
}

function fmtBytes(n) {
  if (n >= MB) return (n / MB).toFixed(2) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

// ============================================================================
// 文件读取小工具
// ============================================================================

/** 从 fd 的 position 处读 length 字节，返回实际读到的 Buffer（循环读满） */
function readAt(fd, length, position) {
  const buf = Buffer.allocUnsafe(Math.max(0, length));
  let off = 0;
  while (off < length) {
    const n = fs.readSync(fd, buf, off, length - off, position + off);
    if (n <= 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 流式 probeHeader：先读 1MB（或文件更短），若 complete=false 则按 need 扩容重读。
 * @returns {{complete:boolean, header:any, fileSize:number, prefixBytes:number, expansions:number}}
 */
function probeStream(filePath, firstReadSize = 1 * MB, keys = TEST_KEY_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    let buf = readAt(fd, Math.min(firstReadSize, fileSize), 0);
    let expansions = 0;
    for (;;) {
      const res = probeHeader(buf, TEST_KEY_BYTES); // 非 TRUNCATED 错误会在这里抛出（测试期望如此）
      // complete=true 表示头部字段已可解析；need=audioOffset 是调用方还应读到的长度。
      // 两种情况下只要 need 比已读长，就按流式约定扩容再读。
      if (res.complete && typeof res.need === 'number' && res.need <= buf.length) {
        return { complete: true, header: res.header, fileSize, prefixBytes: buf.length, expansions };
      }
      const need = res.need;
      assert(typeof need === 'number' && need > 0, `probeHeader need 非法: ${need}`);
      assert(need > buf.length, `probeHeader need (${need}) 未超过已读 (${buf.length})，无法收敛`);
      const next = Math.min(fileSize, Math.max(need, buf.length * 2));
      assert(next > buf.length, `已读 ${buf.length} 但 need=${need} 且文件仅 ${fileSize} 字节`);
      buf = readAt(fd, next, 0);
      expansions++;
      assert(expansions <= 32, 'probeHeader 扩容次数异常');
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** 读音频偏移处前 n 字节密文（用于 createDecoder 选密钥变体 + 嗅探格式） */
function readFirstCipher(filePath, audioOffset, n = 16) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const len = Math.min(n, Math.max(0, fileSize - audioOffset));
    return readAt(fd, len, audioOffset);
  } finally {
    fs.closeSync(fd);
  }
}

// ============================================================================
// 流式解码核心（按给定块长逐块 transformInPlace，对结果做 sha256）
// ============================================================================

/**
 * @param {string} filePath
 * @param {number} audioOffset
 * @param {Uint8Array} keyBox
 * @param {number} blockSize
 * @returns {{digest:string, audioLen:number, ms:number}}
 */
function decodeWithBlockSize(filePath, audioOffset, keyBox, blockSize) {
  assert(Number.isInteger(blockSize) && blockSize >= 1, `块长非法: ${blockSize}`);
  const t0 = nowMs();
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    assert(audioOffset >= 0 && audioOffset <= fileSize, `audioOffset 越界: ${audioOffset}/${fileSize}`);
    const audioLen = fileSize - audioOffset;
    const hash = createHash('sha256');

    // 读盘粒度取 blockSize 的整数倍（且 >= 64KB），保证除文件尾部外
    // 每个 transformInPlace 收到的 chunk 长度都严格等于 blockSize，
    // 而不是被 64KB 读盘边界切出「半块」。
    const ioSize =
      blockSize >= 64 * 1024
        ? blockSize
        : blockSize * Math.ceil((64 * 1024) / blockSize);
    const ioBuf = Buffer.allocUnsafe(ioSize);
    const oneByte = new Uint8Array(1); // 块长 1 时复用，避免逐字节新建视图

    let pos = audioOffset;
    let abs = 0;
    let shortChunks = 0; // 长度 < blockSize 的块（只允许文件最末尾出现 1 个）
    while (pos < fileSize) {
      const want = Math.min(ioSize, fileSize - pos);
      const got = fs.readSync(fd, ioBuf, 0, want, pos);
      assert(got > 0, `读取提前结束 @${pos}`);
      pos += got;

      if (blockSize === 1) {
        for (let i = 0; i < got; i++) {
          oneByte[0] = ioBuf[i];
          transformInPlace(oneByte, keyBox, abs);
          ioBuf[i] = oneByte[0];
          abs++;
        }
      } else {
        let i = 0;
        while (i < got) {
          const n = Math.min(blockSize, got - i);
          if (n !== blockSize) shortChunks++;
          const chunk = ioBuf.subarray(i, i + n);
          transformInPlace(chunk, keyBox, abs);
          abs += n;
          i += n;
        }
      }
      hash.update(ioBuf.subarray(0, got)); // 就地解密后即为明文
    }

    assert(abs === audioLen, `解码字节数 ${abs} != 音频长度 ${audioLen}`);
    const expectedShort = audioLen % blockSize === 0 ? 0 : 1;
    assert(
      shortChunks === expectedShort,
      `非整块 chunk 数=${shortChunks}，期望 ${expectedShort}（audioLen=${audioLen}, blockSize=${blockSize}）`,
    );
    return { digest: hash.digest('hex'), audioLen: abs, ms: nowMs() - t0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** 失败时定位首个不一致字节（仅失败路径调用，不拖慢主流程） */
function locateFirstDiff(filePath, audioOffset, keyBox, expectedPath) {
  const expected = fs.readFileSync(expectedPath);
  const fd = fs.openSync(filePath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const ioSize = 64 * 1024;
    const ioBuf = Buffer.allocUnsafe(ioSize);
    let pos = audioOffset;
    let abs = 0;
    while (pos < fileSize) {
      const want = Math.min(ioSize, fileSize - pos);
      const got = fs.readSync(fd, ioBuf, 0, want, pos);
      if (got <= 0) break;
      pos += got;
      for (let i = 0; i < got; i += 1) {
        const j = i; // 这里按 1 字节块核对差异位置即可，仅为诊断
        transformInPlace(ioBuf.subarray(j, j + 1), keyBox, abs + j);
      }
      for (let i = 0; i < got; i++) {
        if (abs + i >= expected.length || ioBuf[i] !== expected[abs + i]) {
          return { index: abs + i, decoded: ioBuf[i], expected: expected[abs + i] };
        }
      }
      abs += got;
    }
    return { index: abs, decoded: undefined, expected: expected[abs] };
  } finally {
    fs.closeSync(fd);
  }
}

// ============================================================================
// fixture 清单发现
// ============================================================================

/**
 * 主清单 fixtures/manifest.json + 任意 fixtures/<子目录>/manifest.json（large/small）。
 * @returns {{dir:string, manifest:any}[]}
 */
function discoverManifests() {
  const out = [];
  assert(fs.existsSync(FIXTURES), `fixtures 目录不存在: ${FIXTURES}\n请先运行: node tools/make-fixtures.mjs`);

  const mainPath = path.join(FIXTURES, 'manifest.json');
  if (fs.existsSync(mainPath)) {
    out.push({ dir: FIXTURES, manifest: JSON.parse(fs.readFileSync(mainPath, 'utf8')) });
  }
  const subdirs = fs
    .readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of subdirs) {
    const p = path.join(FIXTURES, name, 'manifest.json');
    if (fs.existsSync(p)) {
      out.push({ dir: path.join(FIXTURES, name), manifest: JSON.parse(fs.readFileSync(p, 'utf8')) });
    }
  }
  return out;
}

/** 依据 profile 决定块长矩阵：default 全量；large 只 65536；其它（small）跑轻量三种 */
function blockSizesForProfile(profile) {
  if (profile === 'default') return ALL_BLOCK_SIZES;
  if (profile === 'large') return [65536];
  return [1, 257, 65536];
}

// ============================================================================
// 测试 1：流式解码 × 任意块长 × sha256 比对
// ============================================================================

function testBlockSizeStreaming(manifests) {
  console.log('\n' + '='.repeat(100));
  console.log('1. 流式解码：任意块长逐块 transformInPlace → sha256 与 .expected.* 比对');
  console.log('='.repeat(100));

  for (const { dir, manifest } of manifests) {
    const profile = manifest.profile || path.basename(dir);
    const blockSizes = blockSizesForProfile(profile);
    console.log(
      `\n-- profile=${profile} dir=${dir} 文件=${manifest.files.length} 块长=[${blockSizes.join(', ')}]`,
    );

    for (const entry of manifest.files) {
      const ncmPath = path.join(dir, entry.ncm);
      const expectedPath = path.join(dir, entry.expected);
      assert(fs.existsSync(ncmPath), `缺少样本: ${ncmPath}`);
      assert(fs.existsSync(expectedPath), `缺少 expected: ${expectedPath}`);

      const expectedHash = sha256File(expectedPath);
      const expectedSize = fs.statSync(expectedPath).size;
      assert(
        expectedSize === entry.audioBytes,
        `expected 大小 ${expectedSize} != 清单 audioBytes ${entry.audioBytes}`,
      );

      // --- probeHeader（先读 1MB，必要时扩容） ---
      let stream = null;
      check(`[${profile}] probeHeader 流式解析: ${entry.ncm}`, () => {
        stream = probeStream(ncmPath);
        assert(stream.complete, 'probeHeader 未完成');
        const h = stream.header;
        assert(
          h.audioOffset === stream.fileSize - entry.audioBytes,
          `audioOffset=${h.audioOffset}, 期望 ${stream.fileSize - entry.audioBytes}`,
        );
        assert(h.audioOffset < stream.fileSize, 'audioOffset 越界');
        assert(h.metadata ? typeof h.metadata.musicName === 'string' : entry.metadata === null,
          'probeHeader 返回的 metadata 与清单不符');
        return `audioOffset=${h.audioOffset}, 首读=${fmtBytes(stream.prefixBytes)}, 扩容=${stream.expansions} 次`;
      });
      if (!stream || !stream.complete) continue; // probe 失败则不继续该文件（已记 FAIL）

      // --- createDecoder（含格式嗅探） ---
      let decoder = null;
      check(`[${profile}] createDecoder/格式嗅探: ${entry.ncm}`, () => {
        const firstCipher = readFirstCipher(ncmPath, stream.header.audioOffset, 16);
        assert(firstCipher.length >= 16, `音频首块密文过短: ${firstCipher.length}`);
        decoder = createDecoder(stream.header, firstCipher, stream.fileSize);
        assert(decoder.format === entry.format, `嗅探格式 ${decoder.format} != ${entry.format}`);
        assert(decoder.audioSize === entry.audioBytes, `audioSize ${decoder.audioSize} != ${entry.audioBytes}`);
        return `format=${decoder.format}, keyVariant=${decoder.keyVariant}`;
      });
      if (!decoder) continue;

      // --- 每种块长各解码一次整文件，sha256 必须等于 expected ---
      for (const blockSize of blockSizes) {
        const label = `[${profile}] 块长 ${String(blockSize).padStart(7)} : ${entry.ncm}`;
        check(label, () => {
          const { digest, audioLen, ms } = decodeWithBlockSize(
            ncmPath,
            stream.header.audioOffset,
            decoder.keyBox,
            blockSize,
          );
          if (digest !== expectedHash) {
            let where = '';
            try {
              const diff = locateFirstDiff(ncmPath, stream.header.audioOffset, decoder.keyBox, expectedPath);
              where = `，首个差异 @${diff.index}（解码=0x${(diff.decoded ?? -1).toString(16)} 期望=0x${(diff.expected ?? -1).toString(16)}）`;
            } catch {
              /* 诊断失败不覆盖主错误 */
            }
            throw new Error(
              `sha256 不一致: 解码=${digest.slice(0, 16)}… 期望=${expectedHash.slice(0, 16)}…${where}`,
            );
          }
          bytesDecoded += audioLen;
          return `${fmtBytes(audioLen)}, sha256=${digest.slice(0, 12)}…, ${ms.toFixed(0)}ms`;
        });
      }
    }
  }
}

// ============================================================================
// 测试 2：头部解析边界（截断 / 64KB 前缀）
// ============================================================================

function pickSmallestNcm(manifests) {
  let best = null;
  for (const { dir, manifest } of manifests) {
    for (const entry of manifest.files) {
      if (!best || entry.ncmBytes < best.entry.ncmBytes) best = { dir, manifest, entry };
    }
  }
  return best;
}

/**
 * 找一个「文件很大、但头部能在 64KB 前缀内解析完」的样本，
 * 同时要求 audioOffset > 1KB，以便顺带验证 probeHeader 的扩容路径。
 */
function find64KbProbeCandidate(manifests) {
  let best = null;
  for (const { dir, manifest } of manifests) {
    for (const entry of manifest.files) {
      const filePath = path.join(dir, entry.ncm);
      const size = fs.statSync(filePath).size;
      if (size <= 64 * 1024) continue;
      const fd = fs.openSync(filePath, 'r');
      let prefix;
      try {
        prefix = readAt(fd, Math.min(64 * 1024, size), 0);
      } finally {
        fs.closeSync(fd);
      }
      let res;
      try {
        res = probeHeader(prefix, TEST_KEY_BYTES);
      } catch {
        continue; // 64KB 内已是确定错误，不适合做候选
      }
      if (!res.complete) continue; // 头部字段超过 64KB
      if (typeof res.need !== 'number' || res.need > 64 * 1024) continue; // 头部整体超过 64KB
      const cand = { dir, entry, filePath, size, audioOffset: res.header.audioOffset, prefix };
      if (!best || cand.size > best.size) best = cand;
    }
  }
  return best;
}

function testHeaderBoundaries(manifests) {
  console.log('\n' + '='.repeat(100));
  console.log('2. 头部解析边界：截断前缀 complete=false / need 递增 / 64KB 前缀可 probe');
  console.log('='.repeat(100));

  const smallest = pickSmallestNcm(manifests);
  const candidate = find64KbProbeCandidate(manifests);
  assert(smallest, '没有可用于头部测试的样本');

  const smallPath = path.join(smallest.dir, smallest.entry.ncm);
  const smallFull = fs.readFileSync(smallPath);
  const fullProbe = probeHeader(smallFull, TEST_KEY_BYTES);
  assert(fullProbe.complete, `完整文件 probe 失败: ${smallest.entry.ncm}`);

  /** @type {number[]} */
  const needs = [];
  for (const cut of [5, 13, 20, 30]) {
    check(`截断到 ${cut}B: probeHeader 返回 complete=false 且仅 TRUNCATED`, () => {
      assert(cut < smallFull.length, `截断长度 ${cut} >= 文件长度`);
      const prefix = smallFull.subarray(0, cut);

      // probeHeader 对 TRUNCATED 不应抛出，而应返回 {complete:false, need}
      const res = probeHeader(prefix, TEST_KEY_BYTES);
      assert(res.complete === false, `期望 complete=false，实际 ${JSON.stringify(res)}`);
      assert(typeof res.need === 'number' && Number.isFinite(res.need), `need 非法: ${res.need}`);
      assert(res.need > cut, `need (${res.need}) 应大于已读前缀 (${cut})`);

      // 直接 parseHeader 必须抛 NcmError(TRUNCATED)，而不是其它异常
      let thrown = null;
      try {
        parseHeader(prefix, TEST_KEY_BYTES);
      } catch (e) {
        thrown = e;
      }
      assert(thrown !== null, 'parseHeader 未抛出 TRUNCATED');
      assert(thrown instanceof NcmError, `抛出的不是 NcmError: ${thrown && thrown.name}`);
      assert(thrown.code === 'TRUNCATED', `错误码 ${thrown.code} != TRUNCATED`);

      needs.push(res.need);
      return `need=${res.need}`;
    });
  }

  check('截断 5/13/20/30B: need 非递减（不因前缀变长而回退）', () => {
    assert(needs.length === 4, `needs 数量异常: ${needs.length}`);
    for (let i = 1; i < needs.length; i++) {
      assert(needs[i] >= needs[i - 1], `need 回退: ${needs[i - 1]} -> ${needs[i]}`);
    }
    assert(needs[0] < needs[1], `10/14 阶段 need 未递增: ${needs.join(',')}`);
    assert(needs[1] < needs[2], `14/key_blob 阶段 need 未递增: ${needs.join(',')}`);
    return `needs=[${needs.join(',')}]`;
  });

  check(`64KB 前缀即可 probe 成功（大文件头部很小）: ${candidate ? candidate.entry.ncm : 'N/A'}`, () => {
    assert(candidate, '没有任何「大文件 + 头部 < 64KB」的样本，无法测试 64KB 前缀');
    assert(candidate.size > 1 * MB, `候选文件只有 ${fmtBytes(candidate.size)}，不是大文件`);
    assert(candidate.prefix.length === 64 * 1024, `64KB 前缀读取不完整: ${candidate.prefix.length}B`);

    const res = probeHeader(candidate.prefix, TEST_KEY_BYTES);
    assert(res.complete === true, '64KB 前缀不足以 probe 头部');
    assert(res.need === res.header.audioOffset, `probe.need=${res.need} != audioOffset=${res.header.audioOffset}`);
    assert(
      res.header.audioOffset === candidate.audioOffset,
      `与首次探测的 audioOffset 不一致: ${res.header.audioOffset} != ${candidate.audioOffset}`,
    );
    assert(res.header.audioOffset < 64 * 1024, `头部偏移 ${res.header.audioOffset} 超过 64KB`);
    return `文件=${fmtBytes(candidate.size)}, audioOffset=${res.header.audioOffset}, 前缀冗余=${(64 * 1024 / res.header.audioOffset).toFixed(1)}x`;
  });

  check(`probeStream 扩容路径: 首读不足时按 need 扩容`, () => {
    assert(candidate, '没有合适候选');
    // 首读刻意小于 audioOffset，保证一定触发「need > 已读 → 扩容」分支
    const firstReadSize = Math.max(1, Math.min(1024, candidate.audioOffset - 1));
    const stream = probeStream(candidate.filePath, firstReadSize);
    assert(stream.complete, '扩容后仍未完成 probe');
    assert(
      candidate.audioOffset > firstReadSize,
      `候选头部仅 ${candidate.audioOffset}B，首读 ${firstReadSize}B 就够，无法验证扩容`,
    );
    assert(stream.expansions >= 1, `期望至少扩容 1 次，实际 ${stream.expansions} 次`);
    assert(
      stream.header.audioOffset === candidate.audioOffset,
      `扩容后 audioOffset=${stream.header.audioOffset} != ${candidate.audioOffset}`,
    );
    assert(stream.prefixBytes >= candidate.audioOffset, `扩容后前缀 ${stream.prefixBytes} 仍不足`);
    return `首读 ${fmtBytes(firstReadSize)} → 扩容 ${stream.expansions} 次 → 读到 ${fmtBytes(stream.prefixBytes)}, audioOffset=${stream.header.audioOffset}`;
  });
}

// ============================================================================
// 测试 3：错误处理（BAD_MAGIC / BAD_KEY_LEN / BAD_KEY_PREFIX）
// ============================================================================

function expectNcmError(fn, expectedCode, label) {
  let thrown = null;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  assert(thrown !== null, `${label}: 期望抛出 NcmError(${expectedCode})，实际未抛错`);
  assert(thrown instanceof NcmError, `${label}: 抛出 ${thrown && thrown.name} 而非 NcmError`);
  assert(
    thrown.code === expectedCode,
    `${label}: code=${thrown.code} != ${expectedCode}（${thrown.message}）`,
  );
  return thrown;
}

function testErrorHandling(manifests) {
  console.log('\n' + '='.repeat(100));
  console.log('3. 错误处理：BAD_MAGIC / BAD_KEY_LEN / BAD_KEY_PREFIX');
  console.log('='.repeat(100));

  const smallest = pickSmallestNcm(manifests);
  assert(smallest, '没有可用样本做错误注入');
  const base = fs.readFileSync(path.join(smallest.dir, smallest.entry.ncm));
  const keyLen = base.readUInt32LE(10);

  check('缺少密钥 → NcmError(NO_KEY)，提示提供本地合法密钥', () => {
    const e = expectNcmError(() => probeHeader(base), 'NO_KEY', 'NO_KEY');
    assert(e.message.includes('请提供本地合法的解密密钥'), `提示文案异常: ${e.message}`);
    return e.message;
  });

  check('改坏 magic → NcmError(BAD_MAGIC)', () => {
    const bad = Buffer.from(base);
    bad[0] = 0x58; // 'X'
    bad[1] = 0x58;
    bad[2] = 0x58;
    const e = expectNcmError(() => probeHeader(bad, TEST_KEY_BYTES), 'BAD_MAGIC', 'BAD_MAGIC');
    return e.message;
  });

  check('key_len 改成 0 → NcmError(BAD_KEY_LEN)', () => {
    const bad = Buffer.from(base);
    bad.writeUInt32LE(0, 10);
    const e = expectNcmError(() => parseHeader(bad, TEST_KEY_BYTES), 'BAD_KEY_LEN', 'BAD_KEY_LEN');
    return e.message;
  });

  check('key blob 前 16 字节打乱 → NcmError(BAD_KEY_PREFIX)', () => {
    assert(keyLen >= 16, `key_len=${keyLen} 不足 16，无法构造样本`);
    const bad = Buffer.from(base);
    for (let i = 0; i < 16; i++) bad[14 + i] ^= 0xff;
    const e = expectNcmError(() => parseHeader(bad, TEST_KEY_BYTES), 'BAD_KEY_PREFIX', 'BAD_KEY_PREFIX');
    return e.message;
  });
}

// ============================================================================
// 测试 4：输出命名（中文 / emoji / 非法字符 / 超长 / metadata=null 回退）
// ============================================================================

const ILLEGAL_NAME_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/;

function assertLegalName(name, ext, label) {
  assert(typeof name === 'string' && name.length > 0, `${label}: 结果为空`);
  assert(!ILLEGAL_NAME_CHARS.test(name), `${label}: 含 Windows 非法字符 ${JSON.stringify(name)}`);
  assert(!/[. ]$/.test(name), `${label}: 以点/空格结尾 ${JSON.stringify(name)}`);
  assert(name.length <= 120, `${label}: 长度 ${name.length} > 120`);
  assert(name.endsWith('.' + ext), `${label}: 扩展名丢失 ${JSON.stringify(name)}`);
  return name;
}

function testNaming() {
  console.log('\n' + '='.repeat(100));
  console.log('4. buildOutputName：中文 / emoji / 非法字符 / 超长 / metadata=null 回退');
  console.log('='.repeat(100));

  check('中文且多歌手 → "歌手 & 歌手 - 歌名.mp3"', () => {
    const name = buildOutputName(
      { musicName: 'Test Song', artist: [['Test Artist', 1], ['Example Label', 2]] },
      'whatever.ncm',
      'mp3',
    );
    assert(name === 'Test Artist & Example Label - Test Song.mp3', `实际=${JSON.stringify(name)}`);
    return name;
  });

  check('emoji 歌名 → 保留 emoji、无非法字符、扩展名保留', () => {
    const name = buildOutputName(
      { musicName: '🎵 Emoji Sample 🚀', artist: [['Test Artist', 1]] },
      'x.ncm',
      'mp3',
    );
    assert(name.includes('🎵') && name.includes('🚀'), 'emoji 被丢弃');
    assertLegalName(name, 'mp3', 'emoji');
    return name;
  });

  check('歌名含 / \\ : * ? " < > | → 全部被清洗', () => {
    const name = buildOutputName(
      { musicName: 'a/b\\c:d*e?f"g<h>i|j', artist: [['A/B', 1]] },
      'x.ncm',
      'flac',
    );
    assertLegalName(name, 'flac', 'illegal-chars');
    return name;
  });

  check('超长歌名（500 字符）→ 结果 ≤120 且保留 .flac 扩展名', () => {
    const name = buildOutputName(
      { musicName: 'A'.repeat(500), artist: [['B', 1]] },
      'x.ncm',
      'flac',
    );
    assertLegalName(name, 'flac', 'too-long');
    assert(name.length <= 120, `长度 ${name.length}`);
    return `len=${name.length}, ${name.slice(0, 24)}…${name.slice(-8)}`;
  });

  check('metadata=null → 回退原文件名（去 .ncm、补扩展名）', () => {
    const name = buildOutputName(null, '我的歌.ncm', 'mp3');
    assert(name === '我的歌.mp3', `实际=${JSON.stringify(name)}`);
    return name;
  });

  check('metadata=null + 原文件名含非法字符 → 清洗后合法', () => {
    const name = buildOutputName(null, 'a<b>c?"d|e*.ncm', 'mp3');
    assertLegalName(name, 'mp3', 'null-metadata-illegal');
    return name;
  });

  check('metadata=null + 大写 .NCM 后缀 → 正确剥离', () => {
    const name = buildOutputName(null, 'Song.NCM', 'mp3');
    assert(name === 'Song.mp3', `实际=${JSON.stringify(name)}`);
    return name;
  });

  check('musicName 全空白 → 回退原文件名', () => {
    const name = buildOutputName({ musicName: '   ', artist: [['A', 1]] }, 'fallback.ncm', 'mp3');
    assert(name === 'fallback.mp3', `实际=${JSON.stringify(name)}`);
    return name;
  });

  check('artist 混入非字符串/嵌套项 → 只拼接合法歌手、不崩溃', () => {
    const name = buildOutputName(
      { musicName: '歌', artist: [123, ['有效歌手', 2], null, '字符串歌手'] },
      'x.ncm',
      'mp3',
    );
    assert(name === '有效歌手 & 字符串歌手 - 歌.mp3', `实际=${JSON.stringify(name)}`);
    assertLegalName(name, 'mp3', 'mixed-artist');
    return name;
  });
}

// ============================================================================
// 入口
// ============================================================================

function main() {
  console.log('NCM 解码器字节级正确性测试（roundtrip）');
  console.log(`  core   : ${path.join(ROOT, 'core', 'ncm.js')}`);
  console.log(`  fixtures: ${FIXTURES}`);

  let manifests = [];
  try {
    manifests = discoverManifests();
    assert(manifests.length > 0, `fixtures 下没有任何 manifest.json（${FIXTURES}）`);
  } catch (e) {
    console.error('\n无法加载 fixtures: ' + e.message);
    console.error('请先运行: node tools/make-fixtures.mjs --out fixtures --profile default');
    process.exitCode = 1;
    return;
  }
  const defaultManifest = manifests.find((m) => m.manifest.profile === 'default');
  if (!defaultManifest) {
    console.error('\n未找到 profile=default 的 fixtures/manifest.json，全量块长测试无法进行');
    console.error('请先运行: node tools/make-fixtures.mjs --out fixtures --profile default');
    process.exitCode = 1;
    return;
  }

  testBlockSizeStreaming(manifests);
  testHeaderBoundaries(manifests);
  testErrorHandling(manifests);
  testNaming();

  const elapsedSec = (Date.now() - startedAt) / 1000;
  console.log('\n' + '='.repeat(100));
  if (fail === 0) {
    console.log(
      `汇总: PASS ${pass} / FAIL 0；解码总字节 ${bytesDecoded}（${fmtBytes(bytesDecoded)}）；用时 ${elapsedSec.toFixed(2)}s`,
    );
    console.log('全部通过 ✔');
  } else {
    console.log(
      `汇总: PASS ${pass} / FAIL ${fail}；解码总字节 ${bytesDecoded}（${fmtBytes(bytesDecoded)}）；用时 ${elapsedSec.toFixed(2)}s`,
    );
    console.log('\n失败列表:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
    process.exitCode = 1;
  }
}

main();
