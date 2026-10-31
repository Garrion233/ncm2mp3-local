/**
 * 容量与卡顿极限测试（真实 Chrome + file://，等价于双击打开）。
 *
 *   node tools/verify-stress.mjs                    # 全部场景
 *   node tools/verify-stress.mjs --only singles     # 只测单文件大小上限
 *   node tools/verify-stress.mjs --only batches     # 只测批量并发
 *   node tools/verify-stress.mjs --timeout 600000
 *
 * 前置：Chrome 打开远程调试端口（默认 9333），以及 fixtures-stress/manifest.json：
 *   node tools/make-fixtures.mjs --out fixtures-stress --profile stress --sizes "0.0625:500,4:200,8:100,10:1,50:1,100:1,200:1,400:1,800:1,1024:1"
 *
 * 每个场景采集：总耗时、吞吐、主线程长任务、帧间隔/FPS、定时器漂移、CDP ping 延迟、
 * JS 堆峰值、网络请求数（应为 0，证明"不上传"）、输出字节校验（小批次）。
 * 结果写入 artifacts/stress-results.json（artifacts/ 已被 .gitignore 忽略）。
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
const DIR = path.join(ROOT, 'fixtures-stress');
const OUT = path.join(ROOT, 'artifacts', 'stress-results.json');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const ONLY = opt('--only', 'all');
const TIMEOUT = Number(opt('--timeout', 600000));

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (!fs.existsSync(SINGLE)) throw new Error('缺少 ncm2mp3-batch.html，请先 node tools/build-single.mjs');
if (!fs.existsSync(path.join(DIR, 'manifest.json'))) throw new Error('缺少 fixtures-stress/manifest.json，请先生成压力样本');

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));

/* ---------- 分组：每个 size 一组，count>1 为批量场景 ---------- */
const groups = new Map();
for (const f of manifest.files) {
  const mbTag = (f.features || []).find((x) => x.startsWith('mb-'));
  const nTag = (f.features || []).find((x) => x.startsWith('n-'));
  if (!mbTag || !nTag) continue;
  const sizeMB = Number(mbTag.slice(3));
  const count = Number(nTag.slice(2));
  const key = `${sizeMB}`;
  if (!groups.has(key)) groups.set(key, { sizeMB, count, files: [] });
  groups.get(key).files.push(f);
}

const scenarios = [];
for (const g of groups.values()) {
  const totalIn = g.files.reduce((s, f) => s + f.ncmBytes, 0);
  scenarios.push({
    id: g.count === 1 ? `single-${g.sizeMB}MB` : `batch-${g.count}x${g.sizeMB}MB`,
    kind: g.count === 1 ? 'single' : 'batch',
    sizeMB: g.sizeMB,
    count: g.files.length,
    totalIn,
    files: g.files,
  });
}
scenarios.sort((a, b) => a.totalIn - b.totalIn);
const selected = scenarios.filter((s) => ONLY === 'all' || ONLY === s.kind || ONLY === `${s.kind}s`);

/* ---------- CDP 客户端 ---------- */
const ver = await (await fetch(CDP + '/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = () => j(new Error('无法连接 Chrome CDP：' + CDP));
});
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    clearTimeout(p.t);
    pending.delete(msg.id);
    msg.error ? p.j(new Error(msg.error.message)) : p.r(msg.result);
    return;
  }
};
function send(method, params = {}, sessionId, timeoutMs = 30000) {
  const id = ++seq;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时 ${method}`));
    }, timeoutMs);
    pending.set(id, { r: resolve, j: reject, t });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 页面探针（支持归零：只统计"开始转换之后"的窗口） ---------- */
const PROBE = `(() => {
  const p = { longTasks: { count: 0, maxMs: 0, sumMs: 0 }, raf: { frames: 0, maxGap: 0, t0: 0, t1: 0 }, drift: { samples: 0, max: 0, over50: 0 } };
  window.__probe = p;
  let last = performance.now();
  let exp = performance.now() + 50;
  window.__probeReset = () => {
    p.longTasks = { count: 0, maxMs: 0, sumMs: 0 };
    p.raf = { frames: 0, maxGap: 0, t0: 0, t1: 0 };
    p.drift = { samples: 0, max: 0, over50: 0 };
    last = performance.now();
    exp = performance.now() + 50;
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { p.longTasks.count++; p.longTasks.sumMs += e.duration; if (e.duration > p.longTasks.maxMs) p.longTasks.maxMs = e.duration; }
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  const tick = (ts) => { if (!p.raf.t0) p.raf.t0 = ts; p.raf.t1 = ts; const g = ts - last; last = ts; p.raf.frames++; if (g > p.raf.maxGap) p.raf.maxGap = g; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => { const now = performance.now(); const d = Math.max(0, now - exp); p.drift.samples++; if (d > p.drift.max) p.drift.max = d; if (d > 50) p.drift.over50++; exp = now + 50; }, 50);
  return true;
})()`;

const url = 'file:///' + SINGLE.replace(/\\/g, '/');
const results = [];

for (const sc of selected) {
  const t0 = Date.now();
  const paths = sc.files.map((f) => path.join(DIR, f.ncm));
  const expected = new Map();
  for (const f of sc.files) {
    const p = path.join(DIR, f.expected);
    expected.set(f.ncm, { bytes: fs.statSync(p).size });
  }

  let targetId = null;
  let sessionId = null;
  let crashed = false;
  let networkRequests = 0;
  let pageErrors = 0;
  let peakHeap = 0;
  let baselineFree = os.freemem();
  let minFree = baselineFree;
  const ping = { samples: 0, maxMs: 0, sumMs: 0, timeouts: 0 };
  let metrics = null;
  let probe = null;
  let verify = null;
  let zip = null;
  let netListener = null;

  async function cleanup() {
    if (targetId) await send('Target.closeTarget', { targetId }).catch(() => {});
  }

  try {
    const created = await send('Target.createTarget', { url: 'about:blank' });
    targetId = created.targetId;
    sessionId = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('DOM.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Inspector.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);

    // 网络请求统计：只统计 http(s) 请求（file:// 页面加载本身不算），用于证明"不上传"
    netListener = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.method === 'Network.requestWillBeSent') {
          const u = m.params?.request?.url || '';
          if (/^https?:/i.test(u)) networkRequests++;
        } else if (m.method === 'Runtime.exceptionThrown') pageErrors++;
        else if (m.method === 'Inspector.targetCrashed') crashed = true;
      } catch {}
    };
    ws.addEventListener('message', netListener);

    await send('Page.navigate', { url }, sessionId);
    // 等 hook
    for (let i = 0; i < 100; i++) {
      const ok = await send('Runtime.evaluate', { expression: '!!(window.__ncm && window.__ncm.ready)', returnByValue: true }, sessionId)
        .then((r) => r.result?.value === true)
        .catch(() => false);
      if (ok) break;
      await sleep(100);
    }
    await send('Runtime.evaluate', { expression: PROBE, returnByValue: true }, sessionId);
    // 归零探针：之后统计的都只是"本次转换"窗口内的指标
    await send('Runtime.evaluate', { expression: 'window.__probeReset()', returnByValue: true }, sessionId);
    baselineFree = os.freemem();
    minFree = baselineFree;

    // 注入测试密钥（发布产物本身不含密钥，密钥由使用者输入）
    await send('Runtime.evaluate', {
      expression: `window.__ncm.setKeys(${JSON.stringify(TEST_CORE_KEY)}, ${JSON.stringify(TEST_META_KEY)})`,
      returnByValue: true,
    }, sessionId);

    // 真实文件选择框
    const doc = await send('DOM.getDocument', { depth: -1 }, sessionId);
    const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-input' }, sessionId);
    if (!q.nodeId) throw new Error('页面缺少 #file-input');
    await send('DOM.setFileInputFiles', { files: paths, nodeId: q.nodeId }, sessionId);
    await sleep(500);

    // 起始时间以页面为准
    const startInfo = await send('Runtime.evaluate', {
      expression: '({ files: window.__ncm.getMetrics().files, t0: performance.now() })',
      returnByValue: true,
    }, sessionId);
    if (!startInfo.result?.value?.files) {
      await send('Runtime.evaluate', { expression: `document.querySelector('#file-input').dispatchEvent(new Event('change',{bubbles:true}))` }, sessionId);
    }
    const pageT0 = startInfo.result?.value?.t0 || 0;

    // 轮询：ping 延迟 + 进度 + 堆
    const deadline = Date.now() + TIMEOUT;
    let idleTicks = 0;
    let lastProgress = null;
    while (Date.now() < deadline) {
      const pingStart = Date.now();
      let snapshot = null;
      try {
        const r = await send('Runtime.evaluate', {
          expression: `(() => { const m = window.__ncm.getMetrics(); return { busy: window.__ncm.busy, done: m.done, files: m.files, failed: m.failed, heap: (performance.memory && performance.memory.usedJSHeapSize) || 0, probe: window.__probe }; })()`,
          returnByValue: true,
        }, sessionId, 15000);
        snapshot = r.result?.value;
        const rt = Date.now() - pingStart;
        ping.samples++;
        ping.sumMs += rt;
        if (rt > ping.maxMs) ping.maxMs = rt;
        if (snapshot?.heap > peakHeap) peakHeap = snapshot.heap;
        const free = os.freemem();
        if (free < minFree) minFree = free;
        lastProgress = snapshot;
      } catch (e) {
        // 页面崩溃或主线程完全卡死
        if (String(e.message).includes('超时')) {
          ping.timeouts++;
          crashed = crashed || ping.timeouts > 3;
        } else {
          crashed = true;
          break;
        }
      }
      if (snapshot && !snapshot.busy && snapshot.files > 0 && snapshot.done + snapshot.failed >= snapshot.files) {
        idleTicks++;
        if (idleTicks >= 2) break;
      } else {
        idleTicks = 0;
      }
      await sleep(200);
    }

    if (!crashed) {
      const m = await send('Runtime.evaluate', { expression: 'window.__ncm.getMetrics()', returnByValue: true }, sessionId);
      metrics = m.result?.value;
      const p = await send('Runtime.evaluate', { expression: 'window.__probe', returnByValue: true }, sessionId);
      probe = p.result?.value;
      // 小批次做字节校验（输出 vs 期望）
      if (sc.totalIn <= 200 * 1048576) {
        const shas = await send('Runtime.evaluate', { expression: 'window.__ncm.sha256Results()', awaitPromise: true, returnByValue: true }, sessionId, 300000);
        const shaList = shas.result?.value || [];
        const mismatched = [];
        const byOut = new Map(sc.files.map((f) => [f.expected.replace(/\.expected\./, '.'), f]));
        for (const item of shaList) {
          // 输出文件名 = 元数据命名，改按顺序与期望文件配对
          const idx = shaList.indexOf(item);
          const f = sc.files[idx];
          if (!f) continue;
          const expBuf = await fsp.readFile(path.join(DIR, f.expected));
          const expSha = sha256(expBuf);
          if (expSha !== item.sha256) mismatched.push({ out: item.outName, expected: f.expected });
        }
        verify = { checked: shaList.length, mismatched: mismatched.length, details: mismatched.slice(0, 5) };
      }
      // 中等批次测 ZIP（含 800MB 级批次）
      if (sc.kind === 'batch' && sc.totalIn <= 1.5 * 1024 ** 3) {
        const z = await send('Runtime.evaluate', { expression: 'window.__ncm.makeZip()', awaitPromise: true, returnByValue: true }, sessionId, 300000);
        const zv = z.result?.value;
        if (zv) zip = { ms: Math.round(zv.ms), size: zv.size };
      }
    }
  } catch (e) {
    crashed = true;
  }

  const wall = Date.now() - t0;
  const m = metrics || {};
  const rafFrames = probe?.raf?.frames ?? 0;
  const rafWindow = probe?.raf?.t1 && probe?.raf?.t0 ? (probe.raf.t1 - probe.raf.t0) / 1000 : 0;
  const wallMs = m.wallMs || wall;
  const out = {
    id: sc.id,
    kind: sc.kind,
    sizeMB: sc.sizeMB,
    files: sc.count,
    totalInBytes: sc.totalIn,
    totalOutBytes: m.bytesOut ?? 0,
    status: crashed ? 'crash' : m.failed ? 'partial' : 'ok',
    mode: m.mode ?? null,
    wallMs,
    setupMs: Math.max(0, wall - wallMs),
    throughputMBps: m.throughputMBps ?? (wallMs > 0 ? +(((m.bytesOut || 0) / 1048576 / (wallMs / 1000)).toFixed(1)) : 0),
    longTasks: probe?.longTasks ?? null,
    frameGap: probe?.raf ?? null,
    fps: rafWindow > 0 ? +(rafFrames / rafWindow).toFixed(1) : 0,
    drift: probe?.drift ?? null,
    ping: { samples: ping.samples, maxMs: ping.maxMs, avgMs: ping.samples ? +(ping.sumMs / ping.samples).toFixed(1) : 0, timeouts: ping.timeouts },
    peakHeapMB: +(peakHeap / 1048576).toFixed(1),
    sysMemDropMB: +((baselineFree - minFree) / 1048576).toFixed(1),
    networkRequests,
    pageErrors,
    verify,
    zip,
  };
  results.push(out);
  console.log(
    `  ${out.id.padEnd(22)} ${String(out.files).padStart(4)} 文件  ${(sc.totalIn / 1048576).toFixed(1).padStart(7)} MB  ` +
      `${String(out.wallMs).padStart(7)} ms  ${String(out.throughputMBps).padStart(7)} MB/s  ` +
      `长任务 ${String(out.longTasks?.count ?? '-').padStart(2)}  帧间隔 ${String(Math.round(out.frameGap?.maxGap ?? 0)).padStart(4)} ms  ` +
      `FPS ${String(out.fps).padStart(5)}  ping ${String(out.ping.avgMs).padStart(6)}/${String(out.ping.maxMs).padStart(5)} ms  ` +
      `内存↓ ${String(out.sysMemDropMB).padStart(7)} MB  ${out.status === 'ok' ? '✔' : out.status}`
  );

  await cleanup();
  if (netListener) ws.removeEventListener('message', netListener);
  await sleep(500); // 让 GC / 资源回收
}

const report = {
  schema: 'ncm2mp3-stress/1',
  generatedAt: new Date().toISOString(),
  env: {
    browser: ver.Browser,
    userAgent: ver['User-Agent'],
    cdp: CDP,
    pageProtocol: 'file:',
    viewport: '1280x900',
  },
  scenarios: results,
};
await fsp.mkdir(path.dirname(OUT), { recursive: true });
await fsp.writeFile(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n结果已写入 ${path.relative(ROOT, OUT)}`);

ws.close();
process.exit(0);
