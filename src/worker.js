/**
 * NCM 解码 Worker。
 *
 * 职责：把"一个 NCM 文件 → 一个音频 Blob"的全过程放在 Worker 线程里完成，
 * 主线程永远不接触音频字节（这是消除卡顿的核心）。
 *
 * 关键实现点：
 *   1. 流式读取：File.slice(start, end).arrayBuffer()，块大小默认 4MiB。
 *      不需要把整个文件读进内存，峰值内存 ≈ 块大小 + 输出 Blob。
 *   2. 按绝对偏移生成密钥流（src/ncm.js transformInPlace），因此**任意块长**都正确，
 *      不要求块长是 256 的倍数（一些实现常见的隐含假设）。
 *   3. 解码同一遍里增量计算 CRC32，供 ZIP(STORE) 直接使用，避免二次遍历。
 *   4. 每块之后检查 abort 标志，支持取消；进度按时间节流回传，避免消息风暴。
 */

import {
  probeHeader,
  createDecoder,
  transformInPlace,
  buildOutputName,
  makeKeys,
  NcmError,
} from './ncm.js';
import { crc32Update } from './crc32.js';

const MIME = {
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

const DEFAULT_HEADER_PROBE = 1 << 20; // 1MiB，正常 NCM 头部只有几 KB
const DEFAULT_CHUNK = 4 << 20;
const PROGRESS_INTERVAL_MS = 120;

/** @type {Set<number>} 被取消的任务 id */
const aborted = new Set();

function post(msg) {
  self.postMessage(msg);
}

async function readRange(file, start, end) {
  const buf = await file.slice(start, end).arrayBuffer();
  return new Uint8Array(buf);
}

/** 读取并解析头部（自动扩容读取，直到攒够 cover_len 字段） */
async function readHeader(file, keys) {
  let probeLen = Math.min(DEFAULT_HEADER_PROBE, file.size);
  if (probeLen === 0) throw new NcmError('EMPTY_FILE', '文件为空');
  for (;;) {
    const prefix = await readRange(file, 0, probeLen);
    let result;
    try {
      result = probeHeader(prefix, keys);
    } catch (e) {
      if (e instanceof NcmError && e.code === 'TRUNCATED') {
        if (probeLen >= file.size) throw new NcmError('TRUNCATED', '文件头部不完整（可能下载中断）');
        probeLen = Math.min(Math.max(e.details?.need || probeLen * 2, probeLen * 2), file.size);
        continue;
      }
      throw e;
    }
    if (result.complete) {
      if (result.header.audioOffset > file.size) {
        throw new NcmError('TRUNCATED', `文件不完整：头部声明音频起点 ${result.header.audioOffset}，实际大小 ${file.size}`);
      }
      return result.header;
    }
    if (probeLen >= file.size) throw new NcmError('TRUNCATED', '文件头部不完整（可能下载中断）');
    probeLen = Math.min(Math.max(result.need || probeLen * 2, probeLen * 2), file.size);
  }
}

/** 单个文件转换 */
async function convertOne(file, opts, id) {
  const t0 = performance.now();
  const chunkSize = opts.chunkSize || DEFAULT_CHUNK;
  const keys = makeKeys(opts.coreKey, opts.metaKey);

  const header = await readHeader(file, keys);
  if (header.audioOffset >= file.size) throw new NcmError('NO_AUDIO', '没有音频数据');
  const audioTotal = file.size - header.audioOffset;

  // 先解出音频开头，用真实魔数选择密钥变体 + 判定格式
  const headLen = Math.min(65536, audioTotal);
  const headCipher = await readRange(file, header.audioOffset, header.audioOffset + headLen);
  const dec = createDecoder(header, headCipher, file.size);
  const outName = buildOutputName(header.metadata, file.name, dec.format);
  const mime = MIME[dec.format] || 'application/octet-stream';

  post({
    type: 'meta',
    id,
    outputName: outName,
    format: dec.format,
    formatConfident: dec.confident,
    keyVariant: dec.keyVariant,
    metadata: header.metadata,
    audioTotal,
    ncmSize: file.size,
  });

  let offset = header.audioOffset;
  let done = 0;
  let crc = 0;
  let lastReport = 0;
  /** @type {Uint8Array[]} */
  const parts = [];
  const buf = new Uint8Array(Math.min(chunkSize, audioTotal));

  while (offset < file.size) {
    if (aborted.has(id)) {
      post({ type: 'aborted', id });
      return null;
    }
    const len = Math.min(buf.length, file.size - offset);
    const piece = len === buf.length ? buf : buf.subarray(0, len);
    const ab = await file.slice(offset, offset + len).arrayBuffer();
    piece.set(new Uint8Array(ab));
    transformInPlace(piece, dec.keyBox, done); // 绝对偏移，任意块长均正确
    crc = crc32Update(crc, piece);
    // 复制一块独立内存再放进 parts，避免复用缓冲区导致数据被覆盖
    parts.push(piece.slice());
    done += len;
    offset += len;

    const now = performance.now();
    if (now - lastReport >= PROGRESS_INTERVAL_MS || done === audioTotal) {
      lastReport = now;
      post({ type: 'progress', id, done, total: audioTotal, elapsedMs: now - t0 });
    }
    // 让出事件循环，使 abort / 其他消息能及时送达（Worker 内部）
    await Promise.resolve();
  }

  const blob = new Blob(parts, { type: mime });
  const ms = performance.now() - t0;
  return {
    type: 'done',
    id,
    blob,
    outputName: outName,
    size: done,
    crc32: crc >>> 0,
    format: dec.format,
    metadata: header.metadata,
    ms,
    bytesPerSec: done / (ms / 1000),
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'ping':
      post({ type: 'pong', id: msg.id });
      return;
    case 'abort':
      aborted.add(msg.id);
      return;
    case 'convert': {
      const { id, file, chunkSize, coreKey, metaKey } = msg;
      try {
        const result = await convertOne(file, { chunkSize, coreKey, metaKey }, id);
        if (result) post(result);
      } catch (e) {
        post({
          type: 'error',
          id,
          code: e && e.code ? e.code : 'UNKNOWN',
          message: e && e.message ? e.message : String(e),
        });
      } finally {
        aborted.delete(id);
      }
      return;
    }
    default:
      return;
  }
};
