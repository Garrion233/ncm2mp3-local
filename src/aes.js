/**
 * 纯 JavaScript 的 AES-128 ECB 实现（无任何依赖，浏览器 / Node 通用）。
 *
 * 为什么需要它：
 *   NCM 文件里的「密钥段」和「元信息段」使用 AES-128-ECB 加密（网易私有格式）。
 *   WebCrypto 不提供 ECB 模式，因此这里自带一份最小实现。
 *   只有 2 个小段（几百字节）用到 AES，所以性能不是问题，正确性第一。
 *
 * 实现依据：FIPS-197。导出 aesEcbDecrypt / aesEcbEncrypt，按 16 字节分组，
 * 不做 PKCS#7 去填充（调用方按 NCM 规则自行截断）。
 */

const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;

/** 用标准算法现场生成 S 盒，避免手抄 256 个常量出错。 */
function buildSBox() {
  const sbox = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    // p ← p * 3 （GF(2^8)，不可约多项式 0x11b）
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    // q ← q / 3
    q ^= (q << 1) & 0xff;
    q ^= (q << 2) & 0xff;
    q ^= (q << 4) & 0xff;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    // 仿射变换
    const xformed = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4)) & 0xff;
    sbox[p] = xformed ^ 0x63;
  } while (p !== 1);
  sbox[0] = 0x63;
  return sbox;
}

function buildInvSBox(sbox) {
  const inv = new Uint8Array(256);
  for (let i = 0; i < 256; i++) inv[sbox[i]] = i;
  return inv;
}

export const SBOX = buildSBox();
export const INV_SBOX = buildInvSBox(SBOX);

const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

/** GF(2^8) 乘法 */
function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

/** AES-128 密钥扩展：返回 11 组轮密钥（176 字节） */
export function expandKey128(key) {
  if (key.length !== 16) throw new RangeError('AES-128 需要 16 字节密钥，收到 ' + key.length);
  const w = new Uint8Array(176);
  w.set(key, 0);
  for (let i = 4; i < 44; i++) {
    const o = i * 4;
    let t0 = w[o - 4];
    let t1 = w[o - 3];
    let t2 = w[o - 2];
    let t3 = w[o - 1];
    if (i % 4 === 0) {
      // RotWord + SubWord + Rcon
      const tmp = t0;
      t0 = SBOX[t1] ^ RCON[i / 4 - 1];
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
    }
    const p = o - 16;
    w[o] = w[p] ^ t0;
    w[o + 1] = w[p + 1] ^ t1;
    w[o + 2] = w[p + 2] ^ t2;
    w[o + 3] = w[p + 3] ^ t3;
  }
  return w;
}

function addRoundKey(s, rk, round) {
  const o = round * 16;
  for (let i = 0; i < 16; i++) s[i] ^= rk[o + i];
}

function subBytes(s, box) {
  for (let i = 0; i < 16; i++) s[i] = box[s[i]];
}

/** 状态按列存放：s[r + 4c]；ShiftRows 对第 r 行左移 r 个字节 */
function shiftRows(s) {
  let t;
  // row 1
  t = s[1];
  s[1] = s[5];
  s[5] = s[9];
  s[9] = s[13];
  s[13] = t;
  // row 2
  t = s[2];
  s[2] = s[10];
  s[10] = t;
  t = s[6];
  s[6] = s[14];
  s[14] = t;
  // row 3
  t = s[15];
  s[15] = s[11];
  s[11] = s[7];
  s[7] = s[3];
  s[3] = t;
}

function invShiftRows(s) {
  let t;
  // row 1
  t = s[13];
  s[13] = s[9];
  s[9] = s[5];
  s[5] = s[1];
  s[1] = t;
  // row 2
  t = s[2];
  s[2] = s[10];
  s[10] = t;
  t = s[6];
  s[6] = s[14];
  s[14] = t;
  // row 3
  t = s[3];
  s[3] = s[7];
  s[7] = s[11];
  s[11] = s[15];
  s[15] = t;
}

function mixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    s[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    s[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    s[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}

function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

/** 加密一个 16 字节分组（就地写回 out） */
function encryptBlock(s, rk) {
  addRoundKey(s, rk, 0);
  for (let round = 1; round <= 9; round++) {
    subBytes(s, SBOX);
    shiftRows(s);
    mixColumns(s);
    addRoundKey(s, rk, round);
  }
  subBytes(s, SBOX);
  shiftRows(s);
  addRoundKey(s, rk, 10);
}

/** 解密一个 16 字节分组 */
function decryptBlock(s, rk) {
  addRoundKey(s, rk, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s);
    subBytes(s, INV_SBOX);
    addRoundKey(s, rk, round);
    invMixColumns(s);
  }
  invShiftRows(s);
  subBytes(s, INV_SBOX);
  addRoundKey(s, rk, 0);
}

/**
 * AES-128-ECB 加密（不做填充；输入长度必须是 16 的倍数）。
 * @param {Uint8Array} data
 * @param {Uint8Array} key 16 字节
 * @returns {Uint8Array}
 */
export function aesEcbEncrypt(data, key) {
  if (data.length % 16 !== 0) throw new RangeError('ECB 输入长度必须是 16 的倍数');
  const rk = expandKey128(key);
  const out = new Uint8Array(data.length);
  const s = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    s.set(data.subarray(off, off + 16));
    encryptBlock(s, rk);
    out.set(s, off);
  }
  return out;
}

/**
 * AES-128-ECB 解密（不做去填充；输入长度必须是 16 的倍数）。
 * @param {Uint8Array} data
 * @param {Uint8Array} key 16 字节
 * @returns {Uint8Array}
 */
export function aesEcbDecrypt(data, key) {
  if (data.length % 16 !== 0) throw new RangeError('ECB 输入长度必须是 16 的倍数');
  const rk = expandKey128(key);
  const out = new Uint8Array(data.length);
  const s = new Uint8Array(16);
  for (let off = 0; off < data.length; off += 16) {
    s.set(data.subarray(off, off + 16));
    decryptBlock(s, rk);
    out.set(s, off);
  }
  return out;
}

/** PKCS#7 填充（供测试样本生成器反向构造 NCM 使用） */
export function pkcs7Pad(data, blockSize = 16) {
  const pad = blockSize - (data.length % blockSize);
  const out = new Uint8Array(data.length + pad);
  out.set(data, 0);
  out.fill(pad, data.length);
  return out;
}

/** 去掉 PKCS#7 填充（宽松：填充非法时原样返回） */
export function pkcs7Unpad(data, blockSize = 16) {
  if (data.length === 0) return data;
  const pad = data[data.length - 1];
  if (pad < 1 || pad > blockSize || pad > data.length) return data;
  for (let i = data.length - pad; i < data.length; i++) {
    if (data[i] !== pad) return data;
  }
  return data.subarray(0, data.length - pad);
}
