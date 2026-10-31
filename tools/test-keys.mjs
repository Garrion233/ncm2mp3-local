/**
 * 测试专用密钥（不是真实 NCM 密钥）。
 * 仅用于生成合成测试样本与往返测试；发布产物不包含任何密钥。
 */
const enc = new TextEncoder();

export const TEST_CORE_KEY = 'NCMTESTCOREKEY!!'; // 16 字节
export const TEST_META_KEY = 'NCMTESTMETAKEY!!'; // 16 字节
export const TEST_KEY_BYTES = Object.freeze({
  core: enc.encode(TEST_CORE_KEY),
  meta: enc.encode(TEST_META_KEY),
});
