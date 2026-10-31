/**
 * Node 侧本地配置加载器：优先读取项目根目录的 config.local.json。
 * 该文件包含真实密钥，必须被 .gitignore 忽略，绝不提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @returns {{CORE_KEY: string, META_KEY: string} | null}
 */
export function loadLocalConfig() {
  const candidates = [
    path.join(ROOT, 'config.local.json'),
    path.join(process.cwd(), 'config.local.json'),
  ];
  for (const file of [...new Set(candidates)]) {
    try {
      if (!fs.existsSync(file)) continue;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof data.CORE_KEY === 'string' && data.CORE_KEY.trim() &&
          typeof data.META_KEY === 'string' && data.META_KEY.trim()) {
        return { CORE_KEY: data.CORE_KEY, META_KEY: data.META_KEY };
      }
    } catch {
      /* 配置损坏时继续尝试其他路径 */
    }
  }
  return null;
}
