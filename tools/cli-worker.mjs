/**
 * CLI Worker：单文件转换（Node worker_threads）。
 * 由 cli.mjs 调度；流式读写，峰值内存 ≈ 块大小。
 */

import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

import { probeHeader, createDecoder, transformInPlace, buildOutputName, makeKeys, NcmError } from '../src/ncm.js';
import { crc32Update } from '../src/crc32.js';

const CHUNK = workerData.chunkSize || 4 * 1024 * 1024;
const HEADER_PROBE = 1 << 20;
const KEYS = makeKeys(workerData.keys?.core, workerData.keys?.meta);

async function readHeader(fh, size) {
  let probeLen = Math.min(HEADER_PROBE, size);
  for (;;) {
    const buf = Buffer.alloc(probeLen);
    await fh.read(buf, 0, probeLen, 0);
    let result;
    try {
      result = probeHeader(new Uint8Array(buf.buffer, buf.byteOffset, probeLen), KEYS);
    } catch (e) {
      if (e instanceof NcmError && e.code === 'TRUNCATED') {
        if (probeLen >= size) throw new NcmError('TRUNCATED', '文件头部不完整');
        probeLen = Math.min(Math.max(e.details?.need || probeLen * 2, probeLen * 2), size);
        continue;
      }
      throw e;
    }
    if (result.complete) {
      if (result.header.audioOffset > size) throw new NcmError('TRUNCATED', '头部声明长度超过文件大小');
      return result.header;
    }
    if (probeLen >= size) throw new NcmError('TRUNCATED', '文件头部不完整');
    probeLen = Math.min(Math.max(result.need || probeLen * 2, probeLen * 2), size);
  }
}

async function convertOne({ filePath, outDir, overwrite }) {
  const t0 = performance.now();
  const stat = await fsp.stat(filePath);
  if (stat.size === 0) throw new NcmError('EMPTY_FILE', '文件为空');
  const fh = await fsp.open(filePath, 'r');
  try {
    const header = await readHeader(fh, stat.size);
    const audioSize = stat.size - header.audioOffset;
    if (audioSize <= 0) throw new NcmError('NO_AUDIO', '没有音频数据');

    const headLen = Math.min(65536, audioSize);
    const headBuf = Buffer.alloc(headLen);
    await fh.read(headBuf, 0, headLen, header.audioOffset);
    const dec = createDecoder(header, new Uint8Array(headBuf.buffer, headBuf.byteOffset, headLen), stat.size);

    const baseName = buildOutputName(header.metadata, path.basename(filePath), dec.format);
    await fsp.mkdir(outDir, { recursive: true });
    let outPath = path.join(outDir, baseName);
    if (!overwrite) {
      let n = 2;
      while (fs.existsSync(outPath)) {
        const ext = path.extname(baseName);
        outPath = path.join(outDir, `${baseName.slice(0, baseName.length - ext.length)} (${n})${ext}`);
        n++;
      }
    }
    const tmpPath = outPath + '.part';
    const ws = fs.createWriteStream(tmpPath);
    let offset = header.audioOffset;
    let done = 0;
    let crc = 0;
    let lastReport = 0;

    try {
      while (offset < stat.size) {
        const len = Math.min(CHUNK, stat.size - offset);
        const buf = Buffer.allocUnsafe(len);
        await fh.read(buf, 0, len, offset);
        transformInPlace(new Uint8Array(buf.buffer, buf.byteOffset, len), dec.keyBox, done);
        crc = crc32Update(crc, new Uint8Array(buf.buffer, buf.byteOffset, len));
        if (!ws.write(buf)) await once(ws, 'drain');
        done += len;
        offset += len;
        const now = performance.now();
        if (now - lastReport > 200) {
          lastReport = now;
          parentPort.postMessage({ type: 'progress', filePath, done, total: audioSize });
        }
      }
      ws.end();
      await once(ws, 'finish');
    } catch (e) {
      ws.destroy();
      await fsp.unlink(tmpPath).catch(() => {});
      throw e;
    }
    await fsp.rename(tmpPath, outPath);

    const ms = performance.now() - t0;
    return {
      ok: true,
      filePath,
      outPath,
      format: dec.format,
      bytesIn: stat.size,
      bytesOut: done,
      crc32: crc >>> 0,
      ms,
      metadata: header.metadata,
      keyVariant: dec.keyVariant,
      formatConfident: dec.confident,
    };
  } finally {
    await fh.close();
  }
}

parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'exit') {
    parentPort.close();
    process.exit(0);
  }
  if (msg.type !== 'job') return;
  try {
    const result = await convertOne(msg.payload);
    parentPort.postMessage({ type: 'result', id: msg.id, result });
  } catch (e) {
    parentPort.postMessage({
      type: 'result',
      id: msg.id,
      result: {
        ok: false,
        filePath: msg.payload.filePath,
        error: e?.message || String(e),
        code: e?.code || 'UNKNOWN',
      },
    });
  }
});
