/**
 * NCM 容器解析 + 解密核心（纯 JS，浏览器 / Node / Worker 通用，零依赖）。
 *
 * 权威依据（三份独立实现交叉验证）：
 *   1. ncm2mp3-core 0.3.2 (Rust) — docs.rs 源码：parser.rs / crypto/rc4.rs / format.rs
 *      https://docs.rs/crate/ncm2mp3-core/latest/source/src/
 *   2. Johnserf-Seed/ncm2mp3/docs/ARCHITECTURE.md（含 cover_frame_len 新布局说明）
 *   3. taurusxin/ncmdump src/ncmcrypt.cpp（C++ 参考实现）
 *
 * 磁盘布局（小端）：
 *   [0,8)        magic "CTENFDAM"
 *   [8,10)       2 字节 Gap
 *   [10,14)      key_len (u32)
 *   [14, +key)   key blob       ：需调用方提供 16 字节核心密钥（AES-128-ECB）
 *   [.., +4)     meta_len (u32)
 *   [.., +meta)  meta blob      ：需调用方提供 16 字节元数据密钥（AES-128-ECB）
 *   [.., +4)     crc32 (u32，不校验)
 *   [.., +1)     image version（1 字节，跳过）
 *   [.., +4)     cover_frame_len (u32) — 封面帧总长（图片 + 尾部 padding）
 *   [.., +4)     cover_len (u32)       — 封面图片本身长度
 *   [.., +cover_len)  封面图片（JPEG/PNG，不加密）
 *   [.., +padding)    封面 padding = cover_frame_len - cover_len
 *   [audioOffset, EOF) 音频：NCM 自定义 RC4 变体流密码（见 transformInPlace）
 *
 * 音频偏移 = 31 + key_len + meta_len + cover_frame_len
 */

import { aesEcbDecrypt, pkcs7Unpad } from './aes.js';

export const NCM_MAGIC = 'CTENFDAM';
export const KEY_XOR_MASK = 0x64;
export const META_XOR_MASK = 0x63;
export const KEY_PREFIX = 'neteasecloudmusic';
export const META_PLAIN_PREFIX = "163 key(Don't modify):";
export const META_PREFIX = 'music:';

/**
 * 解析用户提供的密钥文本：16 字节 ASCII 或 32 位十六进制。
 * 密钥不随程序分发，由使用者在本地输入。
 * @param {string} text
 * @param {string} [label]
 * @returns {Uint8Array} 16 字节密钥
 */
export function parseKeyMaterial(text, label = '解密密钥') {
  const s = String(text ?? '').trim();
  if (!s) throw new NcmError('NO_KEY', '请提供本地合法的解密密钥');
  if (/^[0-9a-fA-F]{32}$/.test(s)) {
    return Uint8Array.from(s.match(/.{2}/g), (h) => parseInt(h, 16));
  }
  const bytes = new TextEncoder().encode(s);
  if (bytes.length !== 16) {
    throw new NcmError('BAD_KEY', `${label}必须为 16 字节 ASCII 或 32 位十六进制`);
  }
  return bytes;
}

/** 将两个密钥文本转换为解析器需要的密钥对象 */
export function makeKeys(coreText, metaText) {
  return {
    core: parseKeyMaterial(coreText, '核心密钥'),
    meta: parseKeyMaterial(metaText, '元数据密钥'),
  };
}

/** 解析器统一入口：缺少密钥时给出明确提示 */
function requireKeys(keys) {
  if (!keys || !keys.core || !keys.meta) {
    throw new NcmError('NO_KEY', '请提供本地合法的解密密钥');
  }
  return keys;
}

/** 单个段长度上限（正常 key/meta 只有几 KB，封面最多几 MB） */
export const MAX_SEGMENT_LEN = 64 * 1024 * 1024;
/** 解析头部建议先读取的字节数；不足时会继续扩容读取 */
export const HEADER_PROBE_SIZE = 1024 * 1024;

export class NcmError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'NcmError';
    this.code = code;
    this.details = details || null;
  }
}

const U32 = (buf, off) =>
  (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;

/** 只读小工具：安全截取 UTF-8 字符串 */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/** Base64 → Uint8Array（浏览器 atob / Node Buffer 均可，这里用 atob 以便 worker 通用） */
function base64Decode(str) {
  const clean = str.replace(/[^A-Za-z0-9+/=]/g, '');
  const padded = clean + '==='.slice(0, (4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * RC4 KSA：用 key 材料生成 256 字节置换盒 S。
 * 标准 RC4 KSA（j 累加）——与 ncmdump 的 lastByte 写法等价。
 * @param {Uint8Array} key
 * @returns {Uint8Array}
 */
export function buildKeyBox(key) {
  if (!key || key.length === 0) throw new NcmError('EMPTY_KEY', 'RC4 密钥为空');
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  const klen = key.length;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % klen]) & 0xff;
    const t = S[i];
    S[i] = S[j];
    S[j] = t;
  }
  return S;
}

/**
 * NCM 自定义字节流变换（加密与解密是同一操作：XOR）。
 *
 * 与标准 RC4 的区别：PRGA 不使用演化状态，密钥流字节只取决于**绝对偏移**：
 *   j  = (offset + 1) & 0xFF
 *   a  = S[j]
 *   b  = S[(a + j) & 0xFF]
 *   ks = S[(a + b) & 0xFF]
 *   out[i] = in[i] ^ ks(offset + i)
 *
 * 因此密钥流周期为 256，且任意块长/任意起点都可独立处理——这是流式解码的前提。
 * （很多实现按每 0x8000 缓冲区重置 i，隐含要求块长是 256 的倍数，本实现不需要。）
 *
 * @param {Uint8Array} data 就地修改
 * @param {Uint8Array} keyBox 256 字节盒
 * @param {number} offset 该块在音频流中的绝对偏移（从 0 开始）
 */
export function transformInPlace(data, keyBox, offset) {
  const S = keyBox;
  const n = data.length;
  for (let i = 0; i < n; i++) {
    const j = (offset + i + 1) & 0xff;
    const a = S[j];
    const b = S[(a + j) & 0xff];
    data[i] ^= S[(a + b) & 0xff];
  }
}

/** 只算出偏移 0 开始的 256 字节密钥流（小文件 / 测试用） */
export function keystream(keyBox, length = 256, offset = 0) {
  const out = new Uint8Array(length);
  const S = keyBox;
  for (let i = 0; i < length; i++) {
    const j = (offset + i + 1) & 0xff;
    const a = S[j];
    const b = S[(a + j) & 0xff];
    out[i] = S[(a + b) & 0xff];
  }
  return out;
}

/** 从解密后的音频头字节嗅探真实格式；未知返回 'bin' */
export function sniffFormat(head) {
  if (!head || head.length < 2) return 'bin';
  if (head.length >= 3 && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return 'mp3'; // ID3
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3'; // MPEG 帧同步
  if (head.length >= 4 && head[0] === 0x66 && head[1] === 0x4c && head[2] === 0x61 && head[3] === 0x43) return 'flac';
  if (head.length >= 4 && head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return 'ogg';
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45) return 'wav';
  if (head.length >= 8 && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return 'm4a';
  return 'bin';
}

/** 解析 key blob，返回 { keyUnpadded, keyRawPadded } 两个候选 RC4 密钥材料 */
function decodeKeyBlob(blob, coreKey) {
  const xored = new Uint8Array(blob.length);
  for (let i = 0; i < blob.length; i++) xored[i] = blob[i] ^ KEY_XOR_MASK;
  if (xored.length === 0 || xored.length % 16 !== 0) {
    throw new NcmError('BAD_KEY_LEN', `key 段长度 ${xored.length} 不是 16 的倍数`);
  }
  const plain = aesEcbDecrypt(xored, coreKey);
  const text = decodeUtf8(plain.subarray(0, 17));
  if (text !== KEY_PREFIX) {
    throw new NcmError('BAD_KEY_PREFIX', `key 段前缀异常：期望 "${KEY_PREFIX}"，实际 "${text}"`);
  }
  const unpadded = pkcs7Unpad(plain);
  return {
    // 主流实现（ncmdump / ncm2mp3-core）会去掉 PKCS#7 填充后取前缀之后的部分
    keyUnpadded: unpadded.subarray(KEY_PREFIX.length),
    // 兼容变体：不去填充（极少见，作为嗅探失败时的兜底候选）
    keyRawPadded: plain.subarray(KEY_PREFIX.length),
  };
}

/** 解析 meta blob（容忍失败：返回 null 而不是抛错） */
function decodeMetaBlob(blob, metaKey) {
  try {
    if (blob.length === 0) return null;
    const xored = new Uint8Array(blob.length);
    for (let i = 0; i < blob.length; i++) xored[i] = blob[i] ^ META_XOR_MASK;

    const prefixBytes = new TextEncoder().encode(META_PLAIN_PREFIX);
    let prefixLen = prefixBytes.length;
    // 极少数文件可能没有该前缀，按位置兜底
    for (let i = 0; i < Math.min(prefixBytes.length, xored.length); i++) {
      if (xored[i] !== prefixBytes[i]) { prefixLen = 0; break; }
    }
    const b64 = decodeUtf8(xored.subarray(prefixLen));
    const decoded = base64Decode(b64);
    if (decoded.length === 0 || decoded.length % 16 !== 0) return null;
    const plain = pkcs7Unpad(aesEcbDecrypt(decoded, metaKey));
    let jsonBytes = plain;
    const musicPrefix = new TextEncoder().encode(META_PREFIX);
    let hasPrefix = plain.length >= musicPrefix.length;
    if (hasPrefix) {
      for (let i = 0; i < musicPrefix.length; i++) {
        if (plain[i] !== musicPrefix[i]) { hasPrefix = false; break; }
      }
    }
    if (hasPrefix) jsonBytes = plain.subarray(musicPrefix.length);
    const json = decodeUtf8(jsonBytes).replace(/^\uFEFF/, '');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * 解析 NCM 头部（只需要文件开头的一段即可，不需要整个文件/封面内容）。
 * @param {Uint8Array} buf 文件前缀，长度至少覆盖到 cover_len 字段
 * @param {{core: Uint8Array, meta: Uint8Array}} keys 由使用者提供的 16 字节密钥
 * @returns 头部信息对象
 * @throws {NcmError} code=TRUNCATED 时调用方应读取更多字节后重试
 */
export function parseHeader(buf, keys) {
  const k = requireKeys(keys);
  if (buf.length < 10) throw new NcmError('TRUNCATED', '文件过短，不足 10 字节', { need: 10, have: buf.length });
  const magic = decodeUtf8(buf.subarray(0, 8));
  if (magic !== NCM_MAGIC) throw new NcmError('BAD_MAGIC', `不是 NCM 文件（magic=${JSON.stringify(magic)}）`);

  let need = 14;
  if (buf.length < need) throw new NcmError('TRUNCATED', '头部不完整', { need, have: buf.length, stage: 'key_len' });
  const keyLen = U32(buf, 10);
  if (keyLen === 0 || keyLen > MAX_SEGMENT_LEN) throw new NcmError('BAD_KEY_LEN', `key 段长度异常：${keyLen}`);

  const keyStart = 14;
  const keyEnd = keyStart + keyLen;
  need = keyEnd + 4;
  if (buf.length < need) throw new NcmError('TRUNCATED', '头部不完整', { need, have: buf.length, stage: 'key_blob' });

  const metaLen = U32(buf, keyEnd);
  if (metaLen > MAX_SEGMENT_LEN) throw new NcmError('BAD_META_LEN', `meta 段长度异常：${metaLen}`);
  const metaStart = keyEnd + 4;
  const metaEnd = metaStart + metaLen;

  need = metaEnd + 4 + 1 + 4 + 4; // crc32 + imageVersion + coverFrameLen + coverLen
  if (buf.length < need) throw new NcmError('TRUNCATED', '头部不完整', { need, have: buf.length, stage: 'cover_frame' });

  const crcOffset = metaEnd;
  const imageVersion = buf[crcOffset + 4];
  const coverFrameLen = U32(buf, crcOffset + 5);
  const coverLen = U32(buf, crcOffset + 9);
  if (coverFrameLen > MAX_SEGMENT_LEN || coverLen > coverFrameLen) {
    throw new NcmError('BAD_COVER', `封面长度字段异常：frame=${coverFrameLen} image=${coverLen}`);
  }
  const coverOffset = crcOffset + 13;
  const audioOffset = coverOffset + coverFrameLen;

  const { keyUnpadded, keyRawPadded } = decodeKeyBlob(buf.subarray(keyStart, keyEnd), k.core);
  const metadata = decodeMetaBlob(buf.subarray(metaStart, metaEnd), k.meta);

  return {
    magic,
    keyLen,
    metaLen,
    keyMaterial: keyUnpadded,
    keyMaterialPadded: keyRawPadded,
    metadata,
    formatHint: metadata && typeof metadata.format === 'string' ? metadata.format.toLowerCase() : '',
    coverFrameLen,
    coverLen,
    coverOffset,
    audioOffset,
    imageVersion,
    crc32: U32(buf, crcOffset),
    fileSize: null,
  };
}

/**
 * 解析头部所需的最小前缀长度（用于流式读取时决定第一次读多少）。
 * 返回 { need, complete }；complete=false 表示需要读取整个前缀才能确定。
 */
export function probeHeader(buf, keys) {
  try {
    const header = parseHeader(buf, keys);
    return { complete: true, header, need: header.audioOffset };
  } catch (e) {
    if (e instanceof NcmError && e.code === 'TRUNCATED' && e.details && typeof e.details.need === 'number') {
      return { complete: false, need: e.details.need };
    }
    throw e;
  }
}

/**
 * 结合音频首块密文选择 RC4 密钥材料变体并判定格式。
 * @param {object} header parseHeader 结果
 * @param {Uint8Array} firstCipher 音频最前面的密文字节（至少 16 字节，越多越稳）
 * @param {number} [fileSize] 已知文件大小时填入音频字节数
 */
export function createDecoder(header, firstCipher, fileSize) {
  const variants = [
    { name: 'unpadded', key: header.keyMaterial },
    { name: 'padded', key: header.keyMaterialPadded },
  ];
  const seen = new Set();
  let chosen = null;
  const probe = new Uint8Array(Math.min(16, firstCipher.length));
  probe.set(firstCipher.subarray(0, probe.length));

  for (const v of variants) {
    if (!v.key || v.key.length === 0) continue;
    const id = Array.from(v.key.subarray(0, 8)).join(',') + ':' + v.key.length;
    if (seen.has(id)) continue;
    seen.add(id);
    let box;
    try {
      box = buildKeyBox(v.key);
    } catch {
      continue;
    }
    const head = probe.slice();
    transformInPlace(head, box, 0);
    const fmt = sniffFormat(head);
    if (!chosen && fmt !== 'bin') chosen = { keyBox: box, format: fmt, variant: v.name, confident: true };
    if (!chosen) chosen = { keyBox: box, format: fmt, variant: v.name, confident: false };
  }
  if (!chosen) throw new NcmError('BAD_KEY', '无法构造 RC4 密钥盒');

  // 嗅探失败时退回元信息里的 format 提示
  if (chosen.format === 'bin' && header.formatHint) chosen.format = header.formatHint;
  if (chosen.format === 'bin') chosen.format = 'bin';

  const audioSize = typeof fileSize === 'number' && fileSize >= header.audioOffset
    ? fileSize - header.audioOffset
    : null;

  return {
    keyBox: chosen.keyBox,
    keyVariant: chosen.variant,
    format: chosen.format,
    confident: chosen.confident,
    audioOffset: header.audioOffset,
    audioSize,
  };
}

/** Windows 文件名清洗 */
export function sanitizeFileName(name, maxLen = 120) {
  let s = String(name ?? '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim();
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = 'unnamed';
  if (s.length > maxLen) {
    // 保留扩展名
    const dot = s.lastIndexOf('.');
    if (dot > 0 && s.length - dot <= 8) {
      const ext = s.slice(dot);
      s = s.slice(0, maxLen - ext.length) + ext;
    } else {
      s = s.slice(0, maxLen);
    }
  }
  return s;
}

/**
 * 生成输出文件名：优先 "歌手 - 歌名"，其次元信息歌名，最后原文件名。
 * @param {object|null} metadata NCM 元信息
 * @param {string} originalName 原始 .ncm 文件名
 * @param {string} format 输出扩展名（mp3/flac/...）
 */
export function buildOutputName(metadata, originalName, format) {
  const ext = (format || 'bin').replace(/^\./, '');
  let base = '';
  if (metadata && typeof metadata.musicName === 'string' && metadata.musicName.trim()) {
    const artists = Array.isArray(metadata.artist)
      ? metadata.artist
          .map((a) => (Array.isArray(a) ? a[0] : a))
          .filter((x) => typeof x === 'string' && x.trim())
          .join(' & ')
      : '';
    base = artists ? `${artists} - ${metadata.musicName.trim()}` : metadata.musicName.trim();
  } else {
    base = String(originalName || 'unnamed').replace(/\.ncm$/i, '');
  }
  return sanitizeFileName(`${base}.${ext}`);
}

/** 便捷函数：把整个 NCM 字节流解码成音频字节（Node/测试用；浏览器请用流式） */
export function decodeNcmBuffer(ncmBytes, keys) {
  const header = parseHeader(ncmBytes, keys);
  const headLen = Math.min(16, Math.max(0, ncmBytes.length - header.audioOffset));
  const dec = createDecoder(header, ncmBytes.subarray(header.audioOffset, header.audioOffset + headLen), ncmBytes.length);
  const audio = ncmBytes.slice(header.audioOffset);
  transformInPlace(audio, dec.keyBox, 0);
  return {
    format: dec.format,
    metadata: header.metadata,
    audio,
    header,
    keyVariant: dec.keyVariant,
    outputName: buildOutputName(header.metadata, 'unnamed.ncm', dec.format),
  };
}
