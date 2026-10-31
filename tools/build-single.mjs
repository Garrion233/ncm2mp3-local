#!/usr/bin/env node
/**
 * 单文件打包器：把 src/*.js + src/worker.js + src/final-app.js 内联成一个可双击运行的 HTML。
 *
 *   node tools/build-single.mjs            # 生成 ./ncm2mp3-batch.html
 *   node tools/build-single.mjs --out /path/to/out.html
 *
 * 为什么需要打包：
 *   分享给别人时，最省事的形式是「一个 .html 文件，双击就能用」。但 file:// 下浏览器
 *   不允许 ES Module 跨文件 import，也不允许 new Worker('./worker.js')。
 *   所以这里把源码去掉 import/export 后拼进同一个 <script>，Worker 用 Blob URL 内联创建。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE_ORDER = ['src/aes.js', 'src/crc32.js', 'src/ncm.js', 'src/zip.js'];
const TEMPLATE = path.join(ROOT, 'src', 'template.html');
const DEFAULT_OUT = path.join(ROOT, 'ncm2mp3-batch.html');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** 去掉 ES Module 语法，使其可以拼进同一个经典脚本作用域 */
function stripModuleSyntax(code, file) {
  let out = code;
  // import { ... } from '...'  （可能跨多行）
  out = out.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?[ \t]*$/gm, '');
  // import '...';
  out = out.replace(/^import\s+['"][^'"]+['"]\s*;?[ \t]*$/gm, '');
  // export { ... };
  out = out.replace(/^export\s*\{[\s\S]*?\}\s*;?[ \t]*$/gm, '');
  // export const/let/var/function/class/async function
  out = out.replace(/^export\s+(?=(async\s+function|function|class|const|let|var))/gm, '');

  const leftover = out.match(/^\s*(import|export)\b.*$/m);
  if (leftover) {
    throw new Error(`[build] ${file} 仍残留模块语法：${leftover[0].slice(0, 120)}`);
  }
  return out;
}

/** 语法检查（只解析不执行） */
function assertSyntax(code, label) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
  } catch (e) {
    throw new Error(`[build] ${label} 语法错误：${e.message}`);
  }
}

const started = Date.now();

const coreSrc = CORE_ORDER.map(
  (rel) => `\n/* ================= ${rel} ================= */\n${stripModuleSyntax(read(rel), rel)}`
).join('\n');

const workerSrc = `${coreSrc}\n\n/* ================= src/worker.js ================= */\n${stripModuleSyntax(read('src/worker.js'), 'src/worker.js')}\n`;
assertSyntax(workerSrc, 'worker bundle');

const appSrc = `${coreSrc}\n\n/* ================= src/final-app.js ================= */\n${stripModuleSyntax(read('src/final-app.js'), 'src/final-app.js')}\n`;

// 内联 Worker 工厂：把 worker bundle 变成 Blob URL（file:// 下也可用）
const workerJson = JSON.stringify(workerSrc).replace(/<\/script/gi, '<\\/script');
const factory = `
/* ================= 内联 Worker ================= */
(function () {
  var src = ${workerJson};
  var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  globalThis.__NCM_WORKER_FACTORY__ = function () { return new Worker(url); };
})();
`;

const bundle = `(function () {
  'use strict';
${factory}
${appSrc}
})();`;

assertSyntax(bundle, 'app bundle');

let html = fs.readFileSync(TEMPLATE, 'utf8');
if (!html.includes('/*__NCM_APP_JS__*/')) throw new Error('[build] 模板缺少 /*__NCM_APP_JS__*/ 占位符');
html = html.replace('/*__NCM_APP_JS__*/', () => bundle);

const outPath = process.argv.includes('--out')
  ? path.resolve(process.argv[process.argv.indexOf('--out') + 1])
  : DEFAULT_OUT;
await fsp.mkdir(path.dirname(outPath), { recursive: true });
await fsp.writeFile(outPath, html, 'utf8');

const buf = await fsp.readFile(outPath);
const sha = crypto.createHash('sha256').update(buf).digest('hex');

console.log('');
console.log('  ✅ 单文件已生成');
console.log(`     路径: ${outPath}`);
console.log(`     大小: ${(buf.length / 1024).toFixed(1)} KB`);
console.log(`     SHA-256: ${sha}`);
console.log(`     构建耗时: ${Date.now() - started} ms`);
console.log('');
console.log('  用法：双击打开（或拖进浏览器），把 .ncm 文件拖进页面即可。');
console.log('  自检：node tools/verify-single.mjs');
console.log('');
