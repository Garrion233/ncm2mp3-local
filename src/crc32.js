/**
 * CRC32（IEEE 802.3，ZIP 使用的那种）。查表实现，可用于流式增量计算。
 * 浏览器 / Worker / Node 通用。
 */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * 增量更新 CRC32。首块传 0，后续传上一次返回值。
 * @param {number} crc 上一次的 CRC（首块为 0）
 * @param {Uint8Array} data
 * @param {number} [start]
 * @param {number} [end]
 * @returns {number} 无符号 32 位 CRC
 */
export function crc32Update(crc, data, start = 0, end = data.length) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一次性计算 CRC32 */
export function crc32(data) {
  return crc32Update(0, data);
}
