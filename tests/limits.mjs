#!/usr/bin/env node
/**
 * ZIP 硬上限与边界测试（非 ZIP64 的 4GB / 65535 条目限制）。
 *
 *   node tests/limits.mjs
 *
 * 说明：这里用"声明大小远大于实际 Blob"的假条目来触发 4GB 分支，
 * 不真正分配 4GB 内存；最后一组用 5000 个真实小条目验证结构正确性。
 */

import { buildZipBlob, uniqueZipNames, ZipError } from '../src/zip.js';
import { crc32 } from '../src/crc32.js';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${extra ? '  (' + extra + ')' : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? '  (' + extra + ')' : ''}`);
  }
};

/** 构造一个"声明大小 = declaredSize、实际数据只有 1 字节"的条目 */
function fakeEntry(name, declaredSize) {
  const blob = new Blob([new Uint8Array(1)]);
  return { name, blob, crc32: crc32(new Uint8Array(1)), size: declaredSize };
}

function expectZipError(name, fn, code) {
  try {
    fn();
    check(name, false, '没有抛错');
  } catch (e) {
    check(name, e instanceof ZipError && (!code || e.code === code), e.code || e.message);
  }
}

console.log('===== ZIP 硬上限 =====');
expectZipError('单文件 > 4GB → TOO_LARGE', () => buildZipBlob([fakeEntry('huge.mp3', 4 * 1024 ** 3)]), 'TOO_LARGE');
expectZipError(
  '总量 > 4GB → TOO_LARGE',
  () => buildZipBlob([1, 2, 3, 4, 5].map((i) => fakeEntry(`f${i}.mp3`, 900 * 1024 ** 2))),
  'TOO_LARGE'
);
expectZipError(
  '条目数 65536 > 65535 → TOO_MANY',
  () =>
    buildZipBlob(
      Array.from({ length: 65536 }, (_, i) => ({ name: `a${i}`, blob: new Blob([]), crc32: 0, size: 0 }))
    ),
  'TOO_MANY'
);
expectZipError('空列表 → EMPTY', () => buildZipBlob([]), 'EMPTY');

console.log('\n===== 边界合法值 =====');
{
  // 总量约 4GB − 16KB（含每个条目的本地头）应被接受；用假大小避免真的分配 4GB
  const entries = [1, 2, 3, 4].map((i) => fakeEntry(`near${i}.mp3`, 1024 ** 3 - 4096));
  let ok = false;
  try {
    const z = buildZipBlob(entries);
    ok = z.size > 0;
  } catch (e) {
    ok = false;
  }
  check('总量 ≈ 4GB − 16KB 可构建（结构层）', ok);
}

console.log('\n===== 5000 条目的结构正确性 =====');
{
  const entries = Array.from({ length: 5000 }, (_, i) => {
    const data = new TextEncoder().encode(`file-${i}`);
    return { name: `曲目 ${i}.mp3`, blob: new Blob([data]), crc32: crc32(data), size: data.length };
  });
  const blob = buildZipBlob(entries);
  const buf = Buffer.from(await blob.arrayBuffer());
  const eocd = buf.length - 22;
  check('EOCD 签名正确', buf.readUInt32LE(eocd) === 0x06054b50);
  check('条目数记录 = 5000', buf.readUInt16LE(eocd + 10) === 5000);
  // 扫描中央目录签名数量
  let centralCount = 0;
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === 0x02014b50) centralCount++;
  check('中央目录条目数 = 5000', centralCount === 5000, String(centralCount));
  check('ZIP 体积合理（< 1MB）', buf.length < 1024 * 1024, `${(buf.length / 1024).toFixed(0)} KB`);
}

console.log('\n===== uniqueZipNames 去重 =====');
{
  const names = uniqueZipNames(['a.mp3', 'a.mp3', 'A.MP3', 'b.flac']);
  check('从小到大追加序号且大小写不敏感', JSON.stringify(names) === JSON.stringify(['a.mp3', 'a (2).mp3', 'A (3).MP3', 'b.flac']), JSON.stringify(names));
}

console.log(`\n===== 汇总：PASS ${pass} / FAIL ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
