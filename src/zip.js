/**
 * 极简 ZIP 写入器（仅 STORE 存储模式，不压缩）+ 零拷贝拼装。
 *
 * 设计要点（对应"为什么不再卡顿"）：
 *   1. MP3/FLAC 本身已是压缩格式，再 DEFLATE 几乎不减小体积，却要消耗大量 CPU。
 *      在主线程用 JSZip 做 DEFLATE 的实现，会在批量转换后出现明显的"假死期"。
 *      这里用 STORE（method=0），CPU 开销≈0。
 *   2. ZIP 的本地文件头/中央目录都是几十字节的小块，头像数据用 Blob 引用直接拼进去，
 *      由浏览器负责零拷贝的 Blob 组装，主线程不搬运任何音频字节。
 *   3. CRC32 在解码环节随流增量算出（见 src/crc32.js），不需要二次遍历。
 *
 * 浏览器环境依赖 Blob；Node 18+ 也有全局 Blob，因此可直接在 CLI 里复用。
 */

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800; // bit 11：文件名为 UTF-8
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20; // MS-DOS, 2.0

/** 本地时间 → DOS date/time（ZIP 时间戳，2 秒精度） */
function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function u16(view, off, v) { view[off] = v & 0xff; view[off + 1] = (v >>> 8) & 0xff; }
function u32(view, off, v) {
  view[off] = v & 0xff;
  view[off + 1] = (v >>> 8) & 0xff;
  view[off + 2] = (v >>> 16) & 0xff;
  view[off + 3] = (v >>> 24) & 0xff;
}

export class ZipError extends Error {
  constructor(code, message) { super(message); this.name = 'ZipError'; this.code = code; }
}

const MAX32 = 0xffffffff;

/**
 * 组装一个 STORE 模式 ZIP。
 * @param {Array<{name: string, blob: Blob, crc32: number, size: number, mtime?: Date}>} entries
 * @returns {Blob} application/zip
 */
export function buildZipBlob(entries) {
  if (!entries || entries.length === 0) throw new ZipError('EMPTY', '没有可打包的文件');
  if (entries.length > 65535) throw new ZipError('TOO_MANY', '文件数超过 65535（ZIP 非 ZIP64 上限），请分批下载');

  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();

  for (const entry of entries) {
    const size = entry.size >>> 0;
    if (entry.size > MAX32) throw new ZipError('TOO_LARGE', `单文件超过 4GB：${entry.name}（请用 CLI 或单独下载）`);
    if (offset > MAX32) throw new ZipError('TOO_LARGE', '总大小超过 4GB（ZIP 非 ZIP64 上限），请分批下载或用 CLI 打包');
    const nameBytes = encoder.encode(entry.name);
    const { dosTime, dosDate } = dosDateTime(entry.mtime || now);

    const local = new Uint8Array(30 + nameBytes.length);
    u32(local, 0, LOCAL_SIG);
    u16(local, 4, VERSION_NEEDED);
    u16(local, 6, FLAG_UTF8);
    u16(local, 8, 0); // method = 0 (store)
    u16(local, 10, dosTime);
    u16(local, 12, dosDate);
    u32(local, 14, entry.crc32 >>> 0);
    u32(local, 18, size); // compressed size == size（store）
    u32(local, 22, size);
    u16(local, 26, nameBytes.length);
    u16(local, 28, 0); // extra len
    local.set(nameBytes, 30);

    const cen = new Uint8Array(46 + nameBytes.length);
    u32(cen, 0, CENTRAL_SIG);
    u16(cen, 4, VERSION_MADE_BY);
    u16(cen, 6, VERSION_NEEDED);
    u16(cen, 8, FLAG_UTF8);
    u16(cen, 10, 0);
    u16(cen, 12, dosTime);
    u16(cen, 14, dosDate);
    u32(cen, 16, entry.crc32 >>> 0);
    u32(cen, 20, size);
    u32(cen, 24, size);
    u16(cen, 28, nameBytes.length);
    u16(cen, 30, 0); // extra
    u16(cen, 32, 0); // comment
    u16(cen, 34, 0); // disk
    u16(cen, 36, 0); // internal attrs
    u32(cen, 38, 0); // external attrs
    u32(cen, 42, offset); // 本地头偏移
    cen.set(nameBytes, 46);

    parts.push(local, entry.blob);
    central.push(cen);
    offset += local.length + entry.size;
  }

  const centralOffset = offset;
  // 非 ZIP64：中央目录偏移/大小也必须落在 u32 以内（覆盖"总量刚好跨过 4GB"的边界情况）
  if (centralOffset > MAX32) {
    throw new ZipError('TOO_LARGE', '总大小超过 4GB（ZIP 非 ZIP64 上限），请分批下载或用 CLI 打包');
  }
  let centralSize = 0;
  for (const c of central) { parts.push(c); centralSize += c.length; }
  if (centralSize > MAX32) throw new ZipError('TOO_LARGE', 'ZIP 中央目录超过 4GB，请分批下载');

  const end = new Uint8Array(22);
  u32(end, 0, END_SIG);
  u16(end, 4, 0); // disk
  u16(end, 6, 0); // cd disk
  u16(end, 8, entries.length);
  u16(end, 10, entries.length);
  u32(end, 12, centralSize);
  u32(end, 16, centralOffset);
  u16(end, 20, 0); // comment len
  parts.push(end);

  return new Blob(parts, { type: 'application/zip' });
}

/** ZIP 条目名去重：a.mp3, a (2).mp3, ... */
export function uniqueZipNames(names) {
  const used = new Set();
  return names.map((name) => {
    let candidate = name;
    let n = 2;
    while (used.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
      n++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}
