#!/usr/bin/env node
/**
 * 单文件版端到端验证（真实 Chrome，直接用 file:// 打开，模拟"双击"场景）。
 *
 *   node tools/verify-single.mjs                 # Worker 模式
 *   node tools/verify-single.mjs --mainthread    # 强制降级模式（?mainthread=1）
 *
 * 验证内容：
 *   1. file:// 下页面能正常初始化（没有服务器的场景）
 *   2. 用真实的 <input type=file> 选中 NCM 文件（CDP DOM.setFileInputFiles），走完整 UI 流程
 *   3. 输出 SHA-256 与 fixtures/*.expected.* 完全一致
 *   4. 「下载全部」真正落盘且字节正确
 *   5. 「打包 ZIP」落盘、是合法 ZIP、内容与单独下载一致
 *   6. 转换期间主线程保持可响应（rAF 帧计数器持续推进）
 *
 * 需要先有一个可用的 Chrome DevTools 端点（默认 http://127.0.0.1:9333）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TEST_CORE_KEY, TEST_META_KEY } from './test-keys.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9333';
const SINGLE = path.join(ROOT, 'ncm2mp3-batch.html');
const FORCE_MAIN = process.argv.includes('--mainthread');

const FIXTURES = [
  'Test Artist - Test Song.mp3.ncm',
  'Example Artist - Example Song.flac.ncm',
  '无元信息 - NoMeta.mp3.ncm',
  'tiny-64k.mp3.ncm',
];

const sha256File = async (p) => {
  const buf = await fsp.readFile(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
};

if (!fs.existsSync(SINGLE)) {
  console.error('未找到单文件，请先运行 node tools/build-single.mjs');
  process.exit(2);
}

// 下载验证放在系统临时目录，验证结束自动删除，不污染项目
const DOWNLOADS = await fsp.mkdtemp(path.join(os.tmpdir(), 'ncm2mp3-verify-'));


/* ---------------- CDP 客户端 ---------------- */
const ver = await (await fetch(CDP + '/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error(`无法连接 Chrome CDP：${CDP}`));
});
let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    clearTimeout(p.t);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    return;
  }
  events.push(msg);
};
function send(method, params = {}, sessionId, timeoutMs = 60000) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, t });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = 'file:///' + SINGLE.replace(/\\/g, '/') + (FORCE_MAIN ? '?mainthread=1' : '');

await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('DOM.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url }, sessionId);

async function evaluate(expression, timeoutMs = 60000) {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs },
    sessionId,
    timeoutMs + 20000
  );
  if (r.exceptionDetails) throw new Error('页面异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

// 等页面就绪
for (let i = 0; i < 100; i++) {
  if (await evaluate('!!(window.__ncm && window.__ncm.ready)').catch(() => false)) break;
  await sleep(150);
}
// 固定浅色主题后再开始转换，保证截图与实际 UI 一致
await evaluate(`localStorage.setItem('ncm2mp3-theme','light'); location.reload();`);
await sleep(900);
for (let i = 0; i < 100; i++) {
  if (await evaluate('!!(window.__ncm && window.__ncm.ready)').catch(() => false)) break;
  await sleep(150);
}
const info = await evaluate(`({ version: window.__ncm.version, protocol: location.protocol, secure: window.isSecureContext, hc: navigator.hardwareConcurrency })`);
console.log(`\n页面：${url}`);
console.log(`协议：${info.protocol} · secureContext=${info.secure} · CPU=${info.hc} · 版本=${info.version}`);

// 主线程响应性探针（rAF 计数器）
await evaluate(`(() => {
  window.__raf = { frames: 0, maxGap: 0 };
  let last = performance.now();
  const tick = (ts) => { window.__raf.frames++; const g = ts - last; last = ts; if (g > window.__raf.maxGap) window.__raf.maxGap = g; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})()`);

// 注入测试密钥（发布产物本身不含密钥，密钥由使用者输入）
await evaluate(
  `window.__ncm.setKeys(${JSON.stringify(TEST_CORE_KEY)}, ${JSON.stringify(TEST_META_KEY)})`,
);

// 选中真实文件（走 <input type=file>，等价于用户点选）
const files = FIXTURES.map((f) => path.join(ROOT, 'fixtures', f));
for (const f of files) if (!fs.existsSync(f)) throw new Error('缺少夹具：' + f);
const doc = await send('DOM.getDocument', { depth: -1 }, sessionId);
const { nodeId } = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-input' }, sessionId);
if (!nodeId) throw new Error('页面里找不到 #file-input');
await send('DOM.setFileInputFiles', { files, nodeId }, sessionId);
await sleep(500);
const started = await evaluate('window.__ncm.getMetrics().files');
if (started === 0) {
  // 某些环境下 setFileInputFiles 不派发 change，手动补一次
  await evaluate(`document.querySelector('#file-input').dispatchEvent(new Event('change', { bubbles: true }))`);
  await sleep(500);
}

// 等转换结束
await evaluate('window.__ncm.waitIdle().then(() => true)', 240000);
await sleep(400);

const metrics = await evaluate('window.__ncm.getMetrics()');
const sha = await evaluate('window.__ncm.sha256Results()');
const raf = await evaluate('window.__raf');

// 计算期望 SHA（Node 侧；用 fixtures/manifest.json 做 ncm → expected 映射）
const manifestPath = path.join(ROOT, 'fixtures', 'manifest.json');
const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
const byName = new Map(manifest.files.map((f) => [f.ncm, f]));
const expected = new Map();
for (const ncm of FIXTURES) {
  const item = byName.get(ncm);
  if (!item) throw new Error('manifest 中找不到样本：' + ncm);
  const expPath = path.join(ROOT, 'fixtures', item.expected);
  if (!fs.existsSync(expPath)) throw new Error('缺少期望文件：' + expPath);
  expected.set(ncm, { sha: await sha256File(expPath), bytes: fs.statSync(expPath).size });
}

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

console.log('\n===== 1. 转换结果 =====');
console.log(`  模式=${metrics.mode} · 文件=${metrics.done}/${metrics.files} · 失败=${metrics.failed} · 用时=${metrics.wallMs}ms · 吞吐=${metrics.throughputMBps}MB/s`);
console.log(`  主线程探针：${raf.frames} 帧，最大帧间隔 ${raf.maxGap.toFixed(1)}ms`);
check('文件数 = 4', metrics.files === 4, String(metrics.files));
check('全部转换成功', metrics.done === 4 && metrics.failed === 0, `${metrics.done}/${metrics.failed}`);
check('执行位置符合预期', FORCE_MAIN ? metrics.mode === 'main' : metrics.mode === 'worker', `mode=${metrics.mode}`);
for (const item of sha) {
  const exp = expected.get(item.name);
  check(`字节一致：${item.name}`, !!exp && exp.sha === item.sha256 && exp.bytes === item.bytes, `${item.bytes} B → ${item.outName || ''}`);
}
if (FORCE_MAIN) {
  check('降级模式主线程仍有动画帧推进', raf.frames > 5, `${raf.frames} 帧`);
} else {
  check('Worker 模式主线程无长阻塞（帧间隔 < 50ms）', raf.maxGap < 50, `maxGap=${raf.maxGap.toFixed(1)}ms`);
}

console.log('\n===== 2. 下载全部（真实落盘）=====');
await evaluate('window.__ncm.downloadAll()');
const waitForFiles = async (min, timeoutMs = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const list = (await fsp.readdir(DOWNLOADS)).filter((f) => !f.endsWith('.crdownload'));
    if (list.length >= min) return list;
    await sleep(300);
  }
  return (await fsp.readdir(DOWNLOADS)).filter((f) => !f.endsWith('.crdownload'));
};
const downloaded = await waitForFiles(4);
check('下载了 4 个文件', downloaded.length === 4, downloaded.join(', '));
for (const item of sha) {
  const file = downloaded.find((f) => f === item.outName || f.includes(item.outName.replace(/\.[^.]+$/, '')));
  if (!file) {
    check(`落盘字节：${item.outName}`, false, '未找到下载文件');
    continue;
  }
  const got = await sha256File(path.join(DOWNLOADS, file));
  check(`落盘字节：${file}`, got === item.sha256, `${fs.statSync(path.join(DOWNLOADS, file)).size} B`);
}

console.log('\n===== 3. 打包 ZIP =====');
await evaluate('window.__ncm.downloadZip()');
let zips = [];
for (let i = 0; i < 40; i++) {
  zips = (await fsp.readdir(DOWNLOADS)).filter((f) => f.endsWith('.zip'));
  if (zips.length) break;
  await sleep(400);
}
check('生成了 ZIP 文件', zips.length === 1, zips[0] || '无');
if (zips.length === 1) {
  const zipPath = path.join(DOWNLOADS, zips[0]);
  const buf = await fsp.readFile(zipPath);
  check('ZIP 魔数正确', buf.readUInt32LE(0) === 0x04034b50);
  const m = await evaluate('window.__ncm.getMetrics().zip');
  check('ZIP 大小与页面一致', m && m.size === buf.length, `${buf.length} B / ${m?.size}`);
}

console.log('\n===== 4. 页面异常检查 =====');
const errs = events.filter(
  (e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
);
check('无 JS 异常 / console.error', errs.length === 0, errs.slice(0, 2).map((e) => JSON.stringify(e.params).slice(0, 160)).join(' | '));

// 截图（默认模式刷新 docs/screenshot.png；页面已在浅色主题下运行）
await evaluate(`document.querySelector('#toast')?.classList.remove('show')`);
const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId, 60000);
if (!FORCE_MAIN) {
  const shot = path.join(ROOT, 'docs', 'screenshot.png');
  await fsp.mkdir(path.dirname(shot), { recursive: true });
  await fsp.writeFile(shot, Buffer.from(data, 'base64'));
  console.log(`\n截图：${shot}`);
}
console.log(`\n===== 汇总：PASS ${pass} / FAIL ${fail} =====`);

await send('Target.closeTarget', { targetId });
ws.close();
await fsp.rm(DOWNLOADS, { recursive: true, force: true }).catch(() => {});
process.exit(fail === 0 ? 0 : 1);
