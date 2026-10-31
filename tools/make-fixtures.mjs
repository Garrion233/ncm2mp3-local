#!/usr/bin/env node
/**
 * tools/make-fixtures.mjs
 * -----------------------------------------------------------------------------
 * NCM 测试样本「反向生成器」+ 自检（零依赖，Node >= 18，ESM）。
 *
 * 核心解码器（src/ncm.js、src/aes.js）已冻结，本脚本只做**生成端**：
 *   按 NCM 磁盘布局（小端）逐字段构造 .ncm，并同时落盘明文音频 .expected.<ext>，
 *   然后立刻用 decodeNcmBuffer 解码回读，做字节级 / 元信息级断言。
 *
 * 磁盘布局（与 src/ncm.js 注释一致，权威）：
 *   [0,8)      magic "CTENFDAM"
 *   [8,10)     2 字节 gap（0x01 0x70）
 *   [10,14)    key_len u32
 *   [14,..)    key blob  = XOR0x64(AES-128-ECB(pkcs7pad("neteasecloudmusic" + RC4KEY), CORE_KEY))
 *   [..,+4)    meta_len u32
 *   [..,..)    meta blob = XOR0x63("163 key(Don't modify):" + base64(AES-128-ECB(pkcs7pad("music:" + JSON), META_KEY)))
 *   [..,+4)    crc32 u32（填 0，解码器不校验）
 *   [..,+1)    image version（0x01）
 *   [..,+4)    cover_frame_len u32（= cover_len + padding）
 *   [..,+4)    cover_len u32
 *   [..,..)    封面图片 cover_len 字节；随后 padding 字节 0
 *   [..,EOF)   音频密文 = 明文 XOR NCM 密钥流（与解码同一个 transformInPlace，
 *              密钥盒 = buildKeyBox(RC4KEY)，offset = 音频流内绝对偏移）
 *
 * 用法：
 *   node tools/make-fixtures.mjs --out fixtures --profile default
 *   node tools/make-fixtures.mjs --out fixtures-large --profile large
 *   node tools/make-fixtures.mjs --out fixtures-small --profile small
 *   node tools/make-fixtures.mjs --seed 12345            # 固定随机种子（默认固定）
 *   node tools/make-fixtures.mjs --clean-only            # 只清理清单里登记的文件
 *
 * 注意：manifest.json 描述「本次 profile」；不同 profile 请用不同 --out 目录，
 *       否则后一次运行会先清理上一次清单登记的文件（避免目录里残留脏样本）。
 *
 * 退出码：0 = 生成且自检全部通过；1 = 任何自检/参数错误。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aesEcbEncrypt, pkcs7Pad } from '../src/aes.js';
import {
  NCM_MAGIC,
  KEY_XOR_MASK,
  META_XOR_MASK,
  KEY_PREFIX,
  META_PLAIN_PREFIX,
  META_PREFIX,
  buildKeyBox,
  transformInPlace,
  sniffFormat,
  decodeNcmBuffer,
} from '../src/ncm.js';
import { TEST_CORE_KEY, TEST_META_KEY, TEST_KEY_BYTES } from './test-keys.mjs';

const CORE_KEY = TEST_KEY_BYTES.core;
const META_KEY = TEST_KEY_BYTES.meta;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');

const DEFAULT_SEED = 0x5eed2026;
const MB = 1024 * 1024;

// ============================================================================
// 确定性 PRNG（xorshift32）——绝不使用 Math.random，保证 --seed 可复现
// ============================================================================

/** @returns {() => number} 返回 uint32 生成器 */
function createRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function next32() {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s >>> 0;
  };
}

/** 由主种子为第 index 个样本派生子种子（与生成顺序解耦） */
function deriveSeed(seed, index) {
  const rng = createRng((seed ^ 0x9e3779b9) + Math.imul(index + 1, 0x85ebca6b));
  return rng() >>> 0;
}

/** 用 PRNG 覆写整个 buffer（4 字节一批，40MB 级别也不会慢） */
function fillRandom(buf, rng) {
  const n = buf.length;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    const v = rng();
    buf[i] = v & 0xff;
    buf[i + 1] = (v >>> 8) & 0xff;
    buf[i + 2] = (v >>> 16) & 0xff;
    buf[i + 3] = (v >>> 24) & 0xff;
  }
  if (i < n) {
    let v = rng();
    for (; i < n; i++) {
      buf[i] = v & 0xff;
      v >>>= 8;
    }
  }
  return buf;
}

// ============================================================================
// 小工具
// ============================================================================

const enc = new TextEncoder();

function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32(value) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

function u8(value) {
  return Buffer.from([value & 0xff]);
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function fmtMB(bytes) {
  return (bytes / MB).toFixed(2) + ' MB';
}

function fmtMs(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(2) + ' s' : ms + ' ms';
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ============================================================================
// NCM 各段构造
// ============================================================================

/** 每样本 16 字节 RC4 密钥：可打印 ASCII，确定性生成 */
function makeRc4Key(rng) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const out = new Uint8Array(16);
  for (let i = 0; i < out.length; i++) out[i] = charset.charCodeAt(rng() % charset.length);
  return out;
}

/** key blob = XOR0x64(AES-128-ECB(pkcs7pad("neteasecloudmusic" + RC4KEY), CORE_KEY)) */
function buildKeyBlob(rc4Key) {
  const plain = pkcs7Pad(concatBytes(enc.encode(KEY_PREFIX), rc4Key));
  const cipher = aesEcbEncrypt(plain, CORE_KEY);
  const blob = Buffer.from(cipher.buffer, cipher.byteOffset, cipher.byteLength);
  for (let i = 0; i < blob.length; i++) blob[i] ^= KEY_XOR_MASK;
  return blob;
}

/** meta blob（meta_len=0 时不调用本函数） */
function buildMetaBlob(metadata) {
  const json = JSON.stringify(metadata);
  const plain = pkcs7Pad(enc.encode(META_PREFIX + json)); // "music:" + JSON
  const cipher = aesEcbEncrypt(plain, META_KEY);
  const b64 = Buffer.from(cipher.buffer, cipher.byteOffset, cipher.byteLength).toString('base64');
  const blob = Buffer.from(META_PLAIN_PREFIX + b64, 'utf8');
  for (let i = 0; i < blob.length; i++) blob[i] ^= META_XOR_MASK;
  return blob;
}

/** 假封面图片（解码器不校验内容，只用到长度；但保留真实魔数便于人工排查） */
function buildCover(kind, len, rng) {
  const cover = Buffer.allocUnsafe(len);
  fillRandom(cover, rng);
  if (kind === 'jpeg') {
    cover[0] = 0xff;
    cover[1] = 0xd8;
    cover[2] = 0xff;
    cover[3] = 0xe0;
    // 假 APP0 长度字段，看起来更像 JPEG
    if (len >= 8) {
      cover[4] = 0x00;
      cover[5] = 0x10;
      cover[6] = 0x4a;
      cover[7] = 0x46;
    }
  } else if (kind === 'png') {
    cover.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    // 假 IHDR 长度/类型
    if (len >= 16) {
      cover[8] = 0x00;
      cover[9] = 0x00;
      cover[10] = 0x00;
      cover[11] = 0x0d;
      cover[12] = 0x49;
      cover[13] = 0x48;
      cover[14] = 0x44;
      cover[15] = 0x52;
    }
  } else if (kind !== 'none') {
    throw new Error(`未知封面类型: ${kind}`);
  }
  return cover;
}

/**
 * 生成「明文音频」：真实容器魔数开头（格式嗅探只看开头 16 字节），其余确定性随机。
 * mp3 → ID3v2 假头；flac → fLaC + 假 STREAMINFO；其余不支持（本生成器只用 mp3/flac）。
 */
function buildAudioPlaintext(format, sizeBytes, rng) {
  if (!Number.isInteger(sizeBytes) || sizeBytes < 64) {
    throw new Error(`音频大小非法: ${sizeBytes}`);
  }
  const buf = Buffer.allocUnsafe(sizeBytes);
  fillRandom(buf, rng);

  if (format === 'mp3') {
    // "ID3" + ver 2.4 + flags 0 + syncsafe tag size（2048）
    buf[0] = 0x49; // I
    buf[1] = 0x44; // D
    buf[2] = 0x33; // 3
    buf[3] = 0x04;
    buf[4] = 0x00;
    buf[5] = 0x00;
    buf[6] = 0x00;
    buf[7] = 0x00;
    buf[8] = 0x10;
    buf[9] = 0x00;
    // ID3 tag 之后放一个看起来像 MPEG-1 Layer III 帧同步的假帧头
    if (sizeBytes > 16) {
      buf[10] = 0xff;
      buf[11] = 0xfb;
      buf[12] = 0x90;
      buf[13] = 0x64;
    }
  } else if (format === 'flac') {
    buf[0] = 0x66; // f
    buf[1] = 0x4c; // L
    buf[2] = 0x61; // a
    buf[3] = 0x43; // C
    // METADATA_BLOCK_HEADER：last=1 type=0(STREAMINFO) length=34
    buf[4] = 0x80;
    buf[5] = 0x00;
    buf[6] = 0x00;
    buf[7] = 0x22;
    // 假 STREAMINFO：min/max block size = 4096, min/max frame size = 0
    buf[8] = 0x10;
    buf[9] = 0x00;
    buf[10] = 0x10;
    buf[11] = 0x00;
    buf[12] = 0x00;
    buf[13] = 0x00;
    buf[14] = 0x00;
    buf[15] = 0x00;
    buf[16] = 0x00;
    buf[17] = 0x00;
    // sample rate 44100 / 2ch / 16bit 的编码（仅装饰性，解码器不解析）
    if (sizeBytes > 42) {
      buf[18] = 0x0a;
      buf[19] = 0xc4;
      buf[20] = 0x42;
      buf[21] = 0xf0;
    }
  } else {
    throw new Error(`不支持的音频格式: ${format}`);
  }
  return buf;
}

// ============================================================================
// profile 定义
// ============================================================================

/** @typedef {{
 *   base: string, format: 'mp3'|'flac', sizeBytes: number,
 *   metadata: object|null, cover: {kind:'jpeg'|'png'|'none', len?: number, padding?: number},
 *   tags?: string[]
 * }} FixtureSpec */

function metadata(overrides) {
  const base = {
    musicId: 123456,
    musicName: 'Test Song',
    artist: [['Test Artist', 1], ['Example Label', 2]],
    album: 'Example Album',
    bitrate: 320000,
    duration: 214000,
    format: 'mp3',
    albumPic: 'https://example.invalid/cover.jpg',
  };
  return { ...base, ...overrides };
}

const PROFILES = {
  /**
   * default：8 个样本，音频合计约 41.6MB（+封面/头部 → 清单约 42MB），
   * 混合 mp3/flac、64KB~8MB、ASCII/emoji 文件名；
   * 覆盖 no-meta / old-client（padding=0）/ no-cover 三种特殊布局。
   */
  default: /** @type {FixtureSpec[]} */ ([
    {
      base: 'Test Artist - Test Song',
      format: 'mp3',
      sizeBytes: 6 * MB,
      metadata: metadata({
        musicId: 1001,
        musicName: 'Test Song',
        artist: [['Test Artist', 123], ['Example Label', 456]],
        album: 'Example Album',
        bitrate: 320000,
        duration: 214000,
        format: 'mp3',
        albumPic: 'https://example.invalid/night.jpg',
      }),
      cover: { kind: 'jpeg', len: 120 * 1024, padding: 32 },
      tags: ['ascii-name', 'multi-artist', 'cover-padding'],
    },
    {
      base: 'Example Artist - Example Song',
      format: 'flac',
      sizeBytes: 8 * MB,
      metadata: metadata({
        musicId: 1002,
        musicName: 'Example Song',
        artist: [['Example Artist', 789]],
        album: 'Example Album 2',
        bitrate: 900000,
        duration: 240000,
        format: 'flac',
        albumPic: 'https://example.invalid/example.png',
      }),
      cover: { kind: 'png', len: 80 * 1024, padding: 16 },
      tags: ['ascii-name', 'flac-8mb'],
    },
    {
      base: '无元信息 - NoMeta',
      format: 'mp3',
      sizeBytes: Math.round(4.5 * MB),
      metadata: null, // meta_len = 0
      cover: { kind: 'jpeg', len: 50 * 1024, padding: 8 },
      tags: ['chinese-name'],
    },
    {
      base: '老客户端 - OldClient',
      format: 'flac',
      sizeBytes: 7 * MB,
      metadata: metadata({
        musicId: 1004,
        musicName: 'Old Client Sample',
        artist: [['Legacy Label', 1]],
        album: 'Compatibility Test',
        bitrate: 900000,
        duration: 300000,
        format: 'flac',
        albumPic: 'https://example.invalid/legacy.png',
      }),
      // 老客户端：cover_frame_len == cover_len，无 padding
      cover: { kind: 'png', len: 64 * 1024, padding: 0 },
      tags: ['chinese-name', 'old-client-no-padding'],
    },
    {
      base: '无封面 - NoCover',
      format: 'mp3',
      sizeBytes: 5 * MB,
      metadata: metadata({
        musicId: 1005,
        musicName: 'No Cover Sample',
        artist: [['Anonymous', 0]],
        album: '',
        bitrate: 192000,
        duration: 180000,
        format: 'mp3',
        albumPic: '',
      }),
      // cover_frame_len = 0 / cover_len = 0
      cover: { kind: 'none', len: 0, padding: 0 },
      tags: ['chinese-name', 'no-cover'],
    },
    {
      base: '🎵 Emoji Sample 🚀 - Test',
      format: 'mp3',
      sizeBytes: 3 * MB,
      metadata: metadata({
        musicId: 1006,
        musicName: '🎵 Emoji Sample 🚀',
        artist: [['Emoji Artist', 999], ['ASCII Artist', 1000]],
        album: 'Emoji Album 🎧',
        bitrate: 320000,
        duration: 200000,
        format: 'mp3',
        albumPic: 'https://example.invalid/emoji.jpg',
      }),
      cover: { kind: 'jpeg', len: 100 * 1024, padding: 64 },
      tags: ['emoji-name', 'multi-artist', 'cover-padding'],
    },
    {
      base: 'Test Track - Test Artist',
      format: 'flac',
      sizeBytes: 8 * MB,
      metadata: metadata({
        musicId: 1007,
        musicName: 'Test Track',
        artist: [['Test Artist', 321]],
        album: 'Example Album 3',
        bitrate: 1000000,
        duration: 260000,
        format: 'flac',
        albumPic: 'https://example.invalid/track.png',
      }),
      cover: { kind: 'png', len: 40 * 1024, padding: 20 },
      tags: ['ascii-name', 'flac-8mb'],
    },
    {
      base: 'tiny-64k',
      format: 'mp3',
      sizeBytes: 64 * 1024,
      metadata: metadata({
        musicId: 1008,
        musicName: 'Tiny Sample 64KB',
        artist: [['Tiny', 7]],
        album: 'Minimal Sample',
        bitrate: 128000,
        duration: 4000,
        format: 'mp3',
        albumPic: 'https://example.invalid/tiny.jpg',
      }),
      cover: { kind: 'jpeg', len: 30 * 1024, padding: 4 },
      tags: ['tiny-64kb'],
    },
  ]),

  /** large：1 个约 40MB 的 mp3，用于单文件吞吐测试 */
  large: /** @type {FixtureSpec[]} */ ([
    {
      base: 'large-40mb - throughput-test',
      format: 'mp3',
      sizeBytes: 40 * MB,
      metadata: metadata({
        musicId: 2001,
        musicName: '40MB Throughput Test',
        artist: [['Benchmark', 1]],
        album: 'Large Fixture',
        bitrate: 320000,
        duration: 3000000,
        format: 'mp3',
        albumPic: 'https://example.invalid/large.jpg',
      }),
      cover: { kind: 'jpeg', len: 256 * 1024, padding: 64 },
      tags: ['ascii-name', 'large-40mb'],
    },
  ]),

  /** small：3 个 1–2MB 样本，快速测试 */
  small: /** @type {FixtureSpec[]} */ ([
    {
      base: 'sample-1 - mp3',
      format: 'mp3',
      sizeBytes: 1 * MB,
      metadata: metadata({
        musicId: 3001,
        musicName: 'Small Sample 1',
        artist: [['One', 1]],
        album: 'Small',
        bitrate: 128000,
        duration: 60000,
        format: 'mp3',
        albumPic: 'https://example.invalid/s1.jpg',
      }),
      cover: { kind: 'jpeg', len: 20 * 1024, padding: 4 },
      tags: ['ascii-name'],
    },
    {
      base: 'sample-2 - flac',
      format: 'flac',
      sizeBytes: Math.round(1.5 * MB),
      metadata: metadata({
        musicId: 3002,
        musicName: 'Small Sample 2',
        artist: [['Two', 2]],
        album: 'Small',
        bitrate: 900000,
        duration: 60000,
        format: 'flac',
        albumPic: 'https://example.invalid/s2.png',
      }),
      cover: { kind: 'png', len: 30 * 1024, padding: 0 },
      tags: ['ascii-name', 'old-client-no-padding'],
    },
    {
      base: 'sample-3 - nocover',
      format: 'mp3',
      sizeBytes: 2 * MB,
      metadata: metadata({
        musicId: 3003,
        musicName: 'Small Sample 3',
        artist: [['Three', 3]],
        album: 'Small',
        bitrate: 192000,
        duration: 90000,
        format: 'mp3',
        albumPic: '',
      }),
      cover: { kind: 'none', len: 0, padding: 0 },
      tags: ['chinese-name', 'no-cover'],
    },
  ]),
};

// ============================================================================
// 单个样本生成
// ============================================================================

/**
 * 生成一个样本（.ncm + .expected.<ext>）。
 * @param {FixtureSpec} spec
 * @param {string} outDir
 * @param {number} seed
 * @param {number} index
 */
function generateOne(spec, outDir, seed, index) {
  const rng = createRng(deriveSeed(seed, index));

  const format = spec.format;
  const metadataObj = spec.metadata ? { ...spec.metadata } : null;
  const audioSize = spec.sizeBytes;

  const audio = buildAudioPlaintext(format, audioSize, rng);
  const rc4Key = makeRc4Key(rng);
  const keyBlob = buildKeyBlob(rc4Key);
  const metaBlob = metadataObj ? buildMetaBlob(metadataObj) : Buffer.alloc(0);
  const coverKind = spec.cover.kind;
  const coverLen = coverKind === 'none' ? 0 : (spec.cover.len ?? 0);
  const padding = coverKind === 'none' ? 0 : (spec.cover.padding ?? 0);
  const coverFrameLen = coverLen + padding;
  const cover = coverKind === 'none' ? Buffer.alloc(0) : buildCover(coverKind, coverLen, rng);
  const padBuf = Buffer.alloc(padding, 0);

  const keyLen = keyBlob.length;
  const metaLen = metaBlob.length;

  const header = Buffer.concat([
    Buffer.from(NCM_MAGIC, 'utf8'),
    Buffer.from([0x01, 0x70]),
    u32(keyLen),
    keyBlob,
    u32(metaLen),
    metaBlob,
    u32(0), // crc32（不校验）
    u8(0x01), // image version
    u32(coverFrameLen),
    u32(coverLen),
    cover,
    padBuf,
  ]);

  // 落盘：先写明文 expected，再原地加密，最后拼 .ncm
  const ncmName = `${spec.base}.${format}.ncm`;
  const expectedName = `${spec.base}.expected.${format}`;
  const ncmPath = path.join(outDir, ncmName);
  const expectedPath = path.join(outDir, expectedName);

  fs.writeFileSync(expectedPath, audio);

  const keyBox = buildKeyBox(rc4Key);
  transformInPlace(audio, keyBox, 0); // 明文 → 密文（与解码同一函数，offset=0 起）

  const ncmBytes = Buffer.concat([header, audio]);
  fs.writeFileSync(ncmPath, ncmBytes);

  const features = collectFeatures(spec, coverKind, padding, coverFrameLen);

  return {
    ncm: ncmName,
    expected: expectedName,
    format,
    ncmBytes: ncmBytes.length,
    audioBytes: audioSize,
    metadata: metadataObj,
    coverLen,
    padding,
    features,
    // 以下为自检/调试辅助字段（不影响 manifest 约定字段）
    rc4Key: Buffer.from(rc4Key).toString('hex'),
    coverFrameLen,
    audioOffset: header.length,
  };
}

function collectFeatures(spec, coverKind, padding, coverFrameLen) {
  const out = new Set(spec.tags || []);
  if (!spec.metadata) out.add('no-meta');
  if (coverFrameLen === 0) out.add('no-cover');
  if (coverFrameLen > 0 && padding === 0) out.add('old-client');
  if (coverKind === 'jpeg') out.add('cover-jpeg');
  if (coverKind === 'png') out.add('cover-png');
  out.add(`format-${spec.format}`);
  return Array.from(out);
}

// ============================================================================
// 自检：用冻结的解码器回读，做字节级 / 元信息 / 格式断言
// ============================================================================

function bytesEqual(a, b) {
  const ua = Buffer.isBuffer(a) ? a : Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const ub = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  return ua.length === ub.length && ua.equals(ub);
}

/**
 * @param {Array<ReturnType<typeof generateOne>>} entries
 * @param {string} outDir
 * @returns {{failures: number, checkedBytes: number, totalMs: number}}
 */
function selfCheck(entries, outDir) {
  console.log('');
  console.log('自检：decodeNcmBuffer 回读 → 与 .expected.* 逐字节比对');
  console.log('-'.repeat(96));
  console.log(
    padRight('文件', 42) + padRight('大小', 12) + padRight('格式', 6) + padRight('耗时', 10) + '结果',
  );
  console.log('-'.repeat(96));

  let failures = 0;
  let checkedBytes = 0;
  let totalMs = 0;

  for (const entry of entries) {
    const ncmPath = path.join(outDir, entry.ncm);
    const expectedPath = path.join(outDir, entry.expected);
    const detail = [];
    const t0 = nowMs();
    let ms = 0;
    try {
      const ncmBytes = fs.readFileSync(ncmPath);
      const expectedBytes = fs.readFileSync(expectedPath);

      if (ncmBytes.length !== entry.ncmBytes) {
        detail.push(`ncmBytes 不一致: 磁盘=${ncmBytes.length} 清单=${entry.ncmBytes}`);
      }
      if (expectedBytes.length !== entry.audioBytes) {
        detail.push(`audioBytes 不一致: 磁盘=${expectedBytes.length} 清单=${entry.audioBytes}`);
      }

      const decoded = decodeNcmBuffer(ncmBytes, TEST_KEY_BYTES);
      ms = nowMs() - t0;
      checkedBytes += decoded.audio.length;

      // 1) 音频字节完全一致
      if (!bytesEqual(decoded.audio, expectedBytes)) {
        let first = -1;
        const n = Math.min(decoded.audio.length, expectedBytes.length);
        for (let i = 0; i < n; i++) {
          if (decoded.audio[i] !== expectedBytes[i]) {
            first = i;
            break;
          }
        }
        detail.push(
          `音频字节不一致（解码=${decoded.audio.length}B 期望=${expectedBytes.length}B 首个差异@${first}）`,
        );
      }
      // 音频长度 + audioOffset 关系
      if (decoded.header.audioOffset !== ncmBytes.length - entry.audioBytes) {
        detail.push(
          `audioOffset 异常: ${decoded.header.audioOffset} != ${ncmBytes.length - entry.audioBytes}`,
        );
      }
      // 2) 元信息一致（含 no-meta 样本 metadata===null）
      if (entry.metadata === null) {
        if (decoded.metadata !== null) detail.push(`期望 metadata=null，实际 ${JSON.stringify(decoded.metadata)}`);
      } else if (!deepEqual(decoded.metadata, entry.metadata)) {
        detail.push(`元信息不一致: 实际=${JSON.stringify(decoded.metadata)}`);
      }
      // 3) 嗅探格式一致（音频开头 / createDecoder 两条路径）
      const sniffed = sniffFormat(decoded.audio.subarray(0, 16));
      if (sniffed !== entry.format) {
        detail.push(`sniffFormat=${sniffed} != ${entry.format}`);
      }
      if (decoded.format !== entry.format) {
        detail.push(`decoder.format=${decoded.format} != ${entry.format}`);
      }
      // 4) 密钥变体应为 unpadded（生成端按标准 PKCS#7 填充）
      if (decoded.keyVariant !== 'unpadded') {
        detail.push(`keyVariant=${decoded.keyVariant} != unpadded`);
      }
      // 5) 封面字段回读
      if (decoded.header.coverLen !== entry.coverLen) {
        detail.push(`coverLen 回读=${decoded.header.coverLen} != ${entry.coverLen}`);
      }
      if (decoded.header.coverFrameLen !== entry.coverFrameLen) {
        detail.push(`coverFrameLen 回读=${decoded.header.coverFrameLen} != ${entry.coverFrameLen}`);
      }
    } catch (e) {
      ms = nowMs() - t0;
      detail.push(`异常: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
    }
    totalMs += ms;

    const ok = detail.length === 0;
    if (!ok) failures++;
    console.log(
      padRight(entry.ncm, 42) +
        padRight(fmtMB(entry.ncmBytes), 12) +
        padRight(entry.format, 6) +
        padRight(fmtMs(ms), 10) +
        (ok ? 'OK' : 'FAIL'),
    );
    for (const d of detail) console.log('  ✗ ' + d);
  }

  console.log('-'.repeat(96));
  console.log(
    `自检合计: ${entries.length - failures}/${entries.length} 通过, ` +
      `回读 ${checkedBytes} 字节 (${fmtMB(checkedBytes)}), 解码耗时 ${fmtMs(totalMs)}`,
  );
  return { failures, checkedBytes, totalMs };
}

function padRight(s, width) {
  // 中文/emoji 按显示宽度补空格（\p{Script=Han}/emoji 粗算 2 列）
  const text = String(s);
  let w = 0;
  for (const ch of text) {
    w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}\u{1f000}-\u{1f02f}\u{2600}-\u{27bf}]/u.test(ch) ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - w));
}

// ============================================================================
// 清理 / 写清单 / CLI
// ============================================================================

/** 删除上一次清单登记的文件（只删自己生成的，不动用户其它文件） */
function cleanPrevious(outDir) {
  const manifestPath = path.join(outDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return 0;
  let removed = 0;
  try {
    const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const f of prev.files || []) {
      for (const key of ['ncm', 'expected']) {
        const p = path.join(outDir, String(f[key] || ''));
        if (f[key] && fs.existsSync(p)) {
          fs.rmSync(p, { force: true });
          removed++;
        }
      }
    }
  } catch {
    // 清单损坏时忽略，后续覆盖写
  }
  fs.rmSync(manifestPath, { force: true });
  return removed;
}

function parseArgs(argv) {
  const opts = {
    out: 'fixtures',
    profile: 'default',
    seed: DEFAULT_SEED,
    help: false,
    cleanOnly: false,
    sizes: '',
    format: 'mp3',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      i++;
      if (i >= argv.length) throw new Error(`参数 ${arg} 缺少取值`);
      return argv[i];
    };
    switch (arg) {
      case '--out':
      case '-o':
        opts.out = take();
        break;
      case '--profile':
      case '-p':
        opts.profile = take();
        break;
      case '--sizes':
        opts.sizes = take();
        break;
      case '--format':
        opts.format = take();
        if (!['mp3', 'flac'].includes(opts.format)) throw new Error('--format 只能是 mp3 或 flac');
        break;
      case '--seed':
        opts.seed = Number.parseInt(take(), 10);
        if (!Number.isFinite(opts.seed)) throw new Error('--seed 需要整数');
        opts.seed = opts.seed >>> 0;
        break;
      case '--clean-only':
        opts.cleanOnly = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  return opts;
}

/** 解析 --sizes：形如 "4:200,8:100,1024:1"（大小MB:数量） */
function parseSizes(arg) {
  const list = [];
  for (const part of String(arg).split(',')) {
    const s = part.trim();
    if (!s) continue;
    const [sizeStr, countStr = '1'] = s.split(':');
    const sizeMB = Number(sizeStr);
    const count = Number.parseInt(countStr, 10);
    if (!Number.isFinite(sizeMB) || sizeMB <= 0) throw new Error(`--sizes 中大小非法: ${part}`);
    if (!Number.isFinite(count) || count < 1 || count > 5000) throw new Error(`--sizes 中数量非法: ${part}`);
    list.push({ sizeMB, count });
  }
  if (list.length === 0) throw new Error('--sizes 不能为空');
  return list;
}

/** 压力测试 profile：按 --sizes 动态生成（大小/数量完全可控） */
function buildStressSpecs(sizesArg, format) {
  const specs = [];
  for (const { sizeMB, count } of parseSizes(sizesArg)) {
    const sizeBytes = Math.round(sizeMB * MB);
    const label = sizeMB >= 1 ? `${sizeMB}MB` : `${Math.round(sizeMB * 1024)}KB`;
    for (let i = 1; i <= count; i++) {
      const suffix = count > 1 ? `-${String(i).padStart(3, '0')}` : '';
      specs.push({
        base: `压力测试-${label}${suffix}`,
        format,
        sizeBytes,
        metadata: metadata({
          musicId: 900000 + specs.length,
          musicName: `压力测试 ${label} #${i}`,
          artist: [['压力测试歌手', 1]],
          album: '压力测试专辑',
          bitrate: format === 'flac' ? 900000 : 320000,
          duration: Math.round((sizeBytes / 32000) * 1000),
          format,
        }),
        cover: { kind: 'jpeg', len: 4096, padding: 16 },
        tags: ['stress', `mb-${sizeMB}`, `n-${count}`, `size-${label}`],
      });
    }
  }
  return specs;
}

function printHelp() {
  console.log(`NCM 测试样本生成器（零依赖）

用法: node tools/make-fixtures.mjs [选项]

选项:
  --out <dir>       输出目录（默认 fixtures，相对当前工作目录）
  --profile <name>  default | large | small | stress（默认 default）
  --sizes <spec>    stress 专用：大小MB:数量，逗号分隔，例如 "4:200,8:100,1024:1"
  --format <fmt>    stress 专用：mp3 | flac（默认 mp3）
  --seed <int>      随机种子（默认 ${DEFAULT_SEED}；同一种子输出完全可复现）
  --clean-only      仅清理该目录中上一次清单登记的文件后退出
  -h, --help        显示本帮助

profile 说明:
  default  8 个样本，约 40–50MB；mp3/flac 混合；含中文/emoji 名；
           含 no-meta / old-client(无 padding) / no-cover 三种特殊布局
  large    1 个约 40MB 的 mp3（单文件吞吐测试）
  small    3 个 1–2MB 样本（快速测试）
  stress   压力测试：按 --sizes 生成任意大小/数量的扁平样本（用于容量与卡顿极限测试）

提示: 不同 profile 建议使用不同 --out 目录，例如
  node tools/make-fixtures.mjs --out fixtures --profile default
  node tools/make-fixtures.mjs --out fixtures-large --profile large
  node tools/make-fixtures.mjs --out fixtures-small --profile small
  node tools/make-fixtures.mjs --out fixtures-stress --profile stress --sizes "4:200,8:100,1024:1"

每个样本输出:
  <base>.<fmt>.ncm           NCM 密文样本
  <base>.expected.<fmt>      对应明文音频（用于字节级比对）
  manifest.json              清单（含 generatedAt/profile/totalBytes/files[]）
生成后自动用 src/ncm.js 的 decodeNcmBuffer 回读自检，任何不一致 exit 1。`);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error('参数错误: ' + e.message);
    console.error('使用 --help 查看用法');
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    printHelp();
    return;
  }

  const outDir = path.resolve(process.cwd(), opts.out);
  let profileSpecs;
  try {
    if (opts.profile === 'stress') {
      profileSpecs = buildStressSpecs(opts.sizes, opts.format);
    } else {
      profileSpecs = PROFILES[opts.profile];
    }
  } catch (e) {
    console.error('参数错误: ' + e.message);
    process.exitCode = 1;
    return;
  }
  if (!profileSpecs) {
    console.error(`未知 profile: ${opts.profile}（可选: ${[...Object.keys(PROFILES), 'stress'].join(' / ')}）`);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const removed = cleanPrevious(outDir);
  if (removed > 0) console.log(`已清理上次清单登记的 ${removed} 个文件`);
  if (opts.cleanOnly) {
    console.log('clean-only 完成: ' + outDir);
    return;
  }

  console.log('NCM 测试样本生成器');
  console.log(`  输出目录: ${outDir}`);
  console.log(`  profile : ${opts.profile}（${profileSpecs.length} 个样本）`);
  console.log(`  seed    : ${opts.seed} (0x${opts.seed.toString(16)})`);
  console.log('');

  const started = nowMs();
  /** @type {Array<ReturnType<typeof generateOne>>} */
  const entries = [];
  for (let i = 0; i < profileSpecs.length; i++) {
    const spec = profileSpecs[i];
    const t0 = nowMs();
    let entry;
    try {
      entry = generateOne(spec, outDir, opts.seed, i);
    } catch (e) {
      console.error(`生成失败 [${i}] ${spec.base}: ${e && e.stack ? e.stack : e}`);
      process.exitCode = 1;
      return;
    }
    entries.push(entry);
    const ms = nowMs() - t0;
    console.log(
      `  [${String(i + 1).padStart(2)}/${profileSpecs.length}] 生成 ` +
        `${padRight(entry.ncm, 42)} ${padRight(fmtMB(entry.ncmBytes), 11)} ${padRight(entry.format, 5)} ${fmtMs(ms)}`,
    );
  }
  const genMs = nowMs() - started;

  const totalBytes = entries.reduce((s, e) => s + e.ncmBytes, 0);
  const totalAudioBytes = entries.reduce((s, e) => s + e.audioBytes, 0);

  const manifest = {
    generatedAt: new Date().toISOString(),
    profile: opts.profile,
    seed: opts.seed,
    totalBytes,
    totalAudioBytes,
    files: entries.map((e) => ({
      ncm: e.ncm,
      expected: e.expected,
      format: e.format,
      ncmBytes: e.ncmBytes,
      audioBytes: e.audioBytes,
      metadata: e.metadata,
      coverLen: e.coverLen,
      padding: e.padding,
      features: e.features,
    })),
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log('');
  console.log('生成合计: ' + fmtMB(totalBytes) + `（音频 ${fmtMB(totalAudioBytes)}），耗时 ${fmtMs(genMs)}`);
  console.log('清单: ' + manifestPath);

  const check = selfCheck(entries, outDir);

  console.log('');
  if (check.failures > 0) {
    console.error(`自检失败: ${check.failures} 个样本不一致（exit 1）`);
    process.exitCode = 1;
    return;
  }
  console.log(`自检全部通过 ✔  ${entries.length} 个样本，合计 ${fmtMB(totalBytes)}，输出目录: ${outDir}`);
}

main();
