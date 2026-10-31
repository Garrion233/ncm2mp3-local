/**
 * 最终分享版应用逻辑（会被 tools/build-single.mjs 打包进单文件 HTML）。
 *
 * 设计目标：双击 .html 即可用（file:// 也行），不需要服务器、不联网、零依赖。
 *  - 正常情况：Worker 池（后台线程）转换，主线程只做 UI；
 *  - 若浏览器/环境不允许 Worker（极少数 file:// 环境），自动降级为「主线程分片 + 让出事件循环」，
 *    仍然不会长时间卡死页面。
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
import { buildZipBlob, uniqueZipNames } from './zip.js';

/* ============================== 基础常量 ============================== */
const MiB = 1048576;
const HARDWARE = navigator.hardwareConcurrency || 4;
// 保守并发：大文件场景下限制同时解码数量，降低浏览器内存峰值
const CONCURRENCY = Math.max(1, Math.min(2, HARDWARE - 1));
const WORKER_CHUNK = 4 * 1048576;
const MAIN_CHUNK = 2 * 1048576; // 降级模式：分片更小，配合 setTimeout 让出主线程
const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg' };

const $ = (sel, root = document) => root.querySelector(sel);

/* ============================== 状态 ============================== */
const state = {
  entries: new Map(),
  order: [],
  seq: 0,
  running: false,
  cancelRequested: false,
  mode: 'worker', // 'worker' | 'main'
  pool: null,
  poolSize: 0,
  startedAt: 0,
  finishedAt: 0,
  idleWaiters: [],
  renderQueued: false,
  pendingRows: [],
  rowRenderScheduled: false,
  seenKeys: new Set(),
  usedNames: new Set(),
  zip: null,
  summary: null,
  keyText: { core: '', meta: '' },
};

/* ============================== 小工具 ============================== */
function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}
function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
const STATUS_TEXT = { queued: '排队中', running: '转换中', done: '完成', error: '失败', aborted: '已取消' };

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/* ============================== Worker 工厂 ============================== */
/**
 * 单文件版由打包器注入 `globalThis.__NCM_WORKER_FACTORY__`（Blob URL Worker）。
 * 返回 null 表示当前环境不支持 Worker，调用方应降级到主线程分片模式。
 */
function canUseWorker() {
  // 调试/验证用：?mainthread=1 强制走主线程降级路径
  try {
    if (new URLSearchParams(location.search).get('mainthread') === '1') return false;
  } catch {
    /* ignore */
  }
  const factory = globalThis.__NCM_WORKER_FACTORY__;
  if (typeof factory !== 'function') return false;
  try {
    const w = factory();
    if (!w) return false;
    w.terminate();
    return true;
  } catch {
    return false;
  }
}

/* ============================== Worker 池 ============================== */
class Pool {
  constructor(size, handlers) {
    this.size = size;
    this.handlers = handlers;
    this.slots = [];
    this.queue = [];
    this.jobs = new Map();
    this.cancelled = new Set();
    this.closed = false;
  }

  spawn() {
    const worker = globalThis.__NCM_WORKER_FACTORY__();
    const slot = { worker, busy: false, currentId: 0, dead: false };
    worker.onmessage = (ev) => this.onMessage(slot, ev.data);
    worker.onerror = (ev) => {
      slot.dead = true;
      const id = slot.currentId;
      slot.currentId = 0;
      if (id) {
        this.handlers.onError(id, { code: 'WORKER_CRASH', message: ev.message || '后台线程异常' });
        const job = this.jobs.get(id);
        this.jobs.delete(id);
        job?.resolve({ done: false });
      }
      this.free(slot);
    };
    this.slots.push(slot);
    return slot;
  }

  acquire() {
    this.slots = this.slots.filter((s) => !s.dead);
    for (const slot of this.slots) if (!slot.busy) return slot;
    if (this.slots.length < this.size) return this.spawn();
    return null;
  }

  run(task) {
    return new Promise((resolve) => {
      this.queue.push({ task, resolve });
      this.dispatch();
    });
  }

  dispatch() {
    while (this.queue.length > 0) {
      // 排队中的任务也要响应取消：不派发，直接结算
      const next = this.queue[0];
      if (this.cancelled.has(next.task.id)) {
        this.queue.shift();
        this.cancelled.delete(next.task.id);
        this.handlers.onAborted(next.task.id);
        next.resolve({ done: false, cancelled: true });
        continue;
      }
      const slot = this.acquire();
      if (!slot) return;
      const job = this.queue.shift();
      slot.busy = true;
      slot.currentId = job.task.id;
      this.jobs.set(job.task.id, job);
      slot.worker.postMessage({
        type: 'convert',
        id: job.task.id,
        file: job.task.file,
        chunkSize: job.task.chunkSize,
        coreKey: job.task.coreKey,
        metaKey: job.task.metaKey,
      });
    }
  }

  onMessage(slot, msg) {
    if (!msg) return;
    const finish = (payload) => {
      const job = this.jobs.get(msg.id);
      this.jobs.delete(msg.id);
      this.cancelled.delete(msg.id);
      job?.resolve(payload);
    };
    try {
      if (msg.type === 'meta') this.handlers.onMeta(msg);
      else if (msg.type === 'progress') this.handlers.onProgress(msg);
      else if (msg.type === 'done') this.handlers.onDone(msg);
      else if (msg.type === 'error') this.handlers.onError(msg.id, msg);
      else if (msg.type === 'aborted') this.handlers.onAborted(msg.id);
    } catch (e) {
      // UI 层异常绝不能把批次卡死：记录并继续调度
      console.error('[ncm] 处理 Worker 消息失败:', e);
      if (msg.type === 'done') this.handlers.onError(msg.id, { code: 'UI_ERROR', message: e?.message || String(e) });
    } finally {
      if (msg.type === 'done' || msg.type === 'error' || msg.type === 'aborted') {
        finish({ done: msg.type === 'done' });
        this.free(slot);
      }
    }
  }

  free(slot) {
    slot.busy = false;
    slot.currentId = 0;
    this.dispatch();
  }

  abort(id) {
    this.cancelled.add(id);
    const slot = this.slots.find((s) => s.currentId === id);
    if (slot) slot.worker.postMessage({ type: 'abort', id });
  }

  close() {
    this.closed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
    for (const job of this.queue) job.resolve({ done: false });
    for (const job of this.jobs.values()) job.resolve({ done: false });
    this.queue = [];
    this.jobs.clear();
    this.cancelled.clear();
  }
}

/* ============================== 输出命名去重 ============================== */
function uniqueOutName(name) {
  let candidate = name;
  let n = 2;
  while (state.usedNames.has(candidate.toLowerCase())) {
    const dot = name.lastIndexOf('.');
    candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
    n++;
  }
  state.usedNames.add(candidate.toLowerCase());
  return candidate;
}

/* ============================== 转换结果落地 ============================== */
function finishEntry(entry, result) {
  entry.status = 'done';
  entry.blob = result.blob;
  entry.bytesOut = result.size;
  entry.crc32 = result.crc32;
  entry.outName = uniqueOutName(result.outName || entry.outName || buildOutputName(null, entry.name, result.format || 'mp3'));
  entry.format = result.format;
  entry.ms = result.ms;
  entry.progress = 1;
  entry.objectUrl = URL.createObjectURL(result.blob);
  scheduleRender();
}

function failEntry(entry, err) {
  if (entry.status === 'aborted') return;
  entry.status = state.cancelRequested ? 'aborted' : 'error';
  entry.error = err?.message || String(err);
  entry.progress = 1;
  scheduleRender();
}

/* ============================== 主线程降级模式 ============================== */
async function readWholeHeader(file, keys) {
  let probeLen = Math.min(1048576, file.size);
  for (;;) {
    const buf = new Uint8Array(await file.slice(0, probeLen).arrayBuffer());
    let pr;
    try {
      pr = probeHeader(buf, keys);
    } catch (e) {
      if (e instanceof NcmError && e.code === 'TRUNCATED' && probeLen < file.size) {
        probeLen = Math.min(file.size, probeLen * 2);
        continue;
      }
      throw e;
    }
    if (pr.complete) {
      if (pr.header.audioOffset > file.size) throw new NcmError('TRUNCATED', '文件不完整');
      return pr.header;
    }
    if (probeLen >= file.size) throw new NcmError('TRUNCATED', '文件头部不完整');
    probeLen = Math.min(file.size, Math.max(pr.need * 2, probeLen * 2));
  }
}

async function convertMainThread(entry, keyText) {
  const file = entry.file;
  const t0 = performance.now();
  const keys = makeKeys(keyText.core, keyText.meta);
  const header = await readWholeHeader(file, keys);
  if (header.audioOffset >= file.size) throw new NcmError('NO_AUDIO', '没有音频数据');
  const audioSize = file.size - header.audioOffset;

  const headLen = Math.min(65536, audioSize);
  const headBuf = new Uint8Array(await file.slice(header.audioOffset, header.audioOffset + headLen).arrayBuffer());
  const dec = createDecoder(header, headBuf, file.size);
  entry.format = dec.format;
  entry.outName = buildOutputName(header.metadata, file.name, dec.format);
  entry.bytesOut = audioSize;
  entry.status = 'running';
  scheduleRender();

  const parts = [];
  let offset = header.audioOffset;
  let done = 0;
  let crc = 0;
  while (offset < file.size) {
    if (state.cancelRequested) throw new NcmError('ABORTED', '已取消');
    const len = Math.min(MAIN_CHUNK, file.size - offset);
    const chunk = new Uint8Array(await file.slice(offset, offset + len).arrayBuffer());
    transformInPlace(chunk, dec.keyBox, done);
    crc = crc32Update(crc, chunk);
    parts.push(chunk);
    done += len;
    offset += len;
    entry.progress = done / audioSize;
    scheduleRender();
    // 关键：让出事件循环，让页面保持可交互（降级模式下仍不至于"无响应"）
    await new Promise((r) => setTimeout(r, 0));
  }
  return {
    blob: new Blob(parts, { type: MIME[dec.format] || 'application/octet-stream' }),
    size: done,
    crc32: crc >>> 0,
    format: dec.format,
    outName: entry.outName,
    ms: performance.now() - t0,
  };
}

/* ============================== 批次执行 ============================== */
function poolHandlers() {
  return {
    onMeta(msg) {
      const entry = state.entries.get(msg.id);
      if (!entry) return;
      entry.status = 'running';
      entry.outName = msg.outputName;
      entry.format = msg.format;
      entry.bytesOut = msg.audioTotal;
      entry.progress = 0;
      scheduleRender();
    },
    onProgress(msg) {
      const entry = state.entries.get(msg.id);
      if (!entry) return;
      entry.progress = msg.total > 0 ? msg.done / msg.total : 0;
      entry.doneBytes = msg.done;
      entry.bytesOut = msg.total;
      scheduleRender();
    },
    onDone(msg) {
      const entry = state.entries.get(msg.id);
      if (!entry) return;
      finishEntry(entry, {
        blob: msg.blob,
        size: msg.size,
        crc32: msg.crc32,
        outName: msg.outputName || entry.outName, // Worker 字段名是 outputName
        format: msg.format,
        ms: msg.ms,
      });
    },
    onError(id, msg) {
      const entry = state.entries.get(id);
      if (entry) failEntry(entry, new NcmError(msg.code || 'ERROR', msg.message || '转换失败'));
    },
    onAborted(id) {
      const entry = state.entries.get(id);
      if (entry) {
        entry.status = 'aborted';
        entry.progress = 1;
        scheduleRender();
      }
    },
  };
}

async function runWorkerMode(entries, keyText) {
  state.mode = 'worker';
  state.pool = new Pool(Math.max(1, CONCURRENCY), poolHandlers());
  state.poolSize = Math.max(1, CONCURRENCY);
  await Promise.all(
    entries.map(async (entry) => {
      const result = await state.pool.run({
        id: entry.id,
        file: entry.file,
        chunkSize: WORKER_CHUNK,
        coreKey: keyText.core,
        metaKey: keyText.meta,
      });
      if (!result || !result.done) {
        if (entry.status === 'queued' || entry.status === 'running') {
          if (state.cancelRequested) entry.status = 'aborted';
        }
      }
    })
  );
  state.pool.close();
  state.pool = null;
  state.poolSize = 0;
}

async function runMainMode(entries, keyText) {
  state.mode = 'main';
  state.poolSize = 0;
  for (const entry of entries) {
    if (state.cancelRequested) {
      entry.status = 'aborted';
      scheduleRender();
      continue;
    }
    entry.status = 'running';
    scheduleRender();
    try {
      const result = await convertMainThread(entry, keyText);
      finishEntry(entry, result);
    } catch (e) {
      failEntry(entry, e);
    }
  }
}

/** 读取并校验 UI 中的两个密钥输入；缺失时提示并返回 null */
function readKeyInputs() {
  const coreEl = $('#key-core');
  const metaEl = $('#key-meta');
  const core = coreEl ? coreEl.value : state.keyText.core;
  const meta = metaEl ? metaEl.value : state.keyText.meta;
  try {
    makeKeys(core, meta);
  } catch (e) {
    toast(e?.message || '请提供本地合法的解密密钥');
    const target = coreEl && !coreEl.value.trim() ? coreEl : metaEl;
    target?.focus();
    return null;
  }
  state.keyText = { core, meta };
  return state.keyText;
}

/** 将密钥写入输入框与内存状态（用于本地配置载入） */
function applyKeyText(core, meta) {
  const coreEl = $('#key-core');
  const metaEl = $('#key-meta');
  if (coreEl) coreEl.value = String(core ?? '');
  if (metaEl) metaEl.value = String(meta ?? '');
  state.keyText = { core: String(core ?? ''), meta: String(meta ?? '') };
}

/** 解析 config.local.json / config.example.json 的 JSON 文本 */
function parseConfigText(text) {
  const data = JSON.parse(text);
  const core = data.CORE_KEY;
  const meta = data.META_KEY;
  if (typeof core !== 'string' || typeof meta !== 'string') {
    throw new Error('配置文件需包含 CORE_KEY 与 META_KEY');
  }
  makeKeys(core, meta); // 仅校验，不保存字节
  return { core, meta };
}

/** 从用户选择的 config.local.json 载入密钥 */
async function loadConfigFile(file) {
  try {
    const text = await file.text();
    const { core, meta } = parseConfigText(text);
    applyKeyText(core, meta);
    toast('已载入本地配置');
  } catch (e) {
    toast('配置载入失败：' + (e?.message || e));
  }
}

/**
 * 尝试自动读取同目录 config.local.json。
 * 仅在通过 HTTP 打开页面时可用；file:// 下浏览器会拒绝本地 fetch，此时回退到手动输入/载入按钮。
 */
async function tryAutoLoadConfig() {
  // file:// 下浏览器禁止本地 fetch，直接回退到手动输入/载入按钮
  if (location.protocol === 'file:') return false;
  try {
    const res = await fetch('config.local.json', { cache: 'no-store' });
    if (!res.ok) return false;
    const { core, meta } = parseConfigText(await res.text());
    applyKeyText(core, meta);
    return true;
  } catch {
    return false;
  }
}

async function startBatch() {
  if (state.running) return;
  const queue = state.order
    .map((id) => state.entries.get(id))
    .filter((e) => e && (e.status === 'queued' || e.status === 'error' || e.status === 'aborted'));
  if (queue.length === 0) {
    toast('没有待转换的文件');
    return;
  }
  const keyText = readKeyInputs();
  if (!keyText) return;
  state.cancelRequested = false;
  state.running = true;
  state.startedAt = performance.now();
  state.finishedAt = 0;
  state.summary = null;
  state.usedNames.clear();
  for (const id of state.order) {
    const e = state.entries.get(id);
    // 已完成的不重跑；重置其余
    if (e.status !== 'done') {
      e.status = 'queued';
      e.progress = 0;
      e.error = null;
    }
  }
  const pending = state.order.map((id) => state.entries.get(id)).filter((e) => e && e.status === 'queued');
  syncButtons();
  scheduleRender();

  try {
    if (canUseWorker()) await runWorkerMode(pending, keyText);
    else await runMainMode(pending, keyText);
  } catch (e) {
    console.error(e);
    toast('转换过程出错：' + (e?.message || e));
    // 兜底：把未完成的条目标记为失败，避免界面一直停在"转换中"
    for (const id of state.order) {
      const entry = state.entries.get(id);
      if (entry && (entry.status === 'queued' || entry.status === 'running')) {
        failEntry(entry, e);
      }
    }
  } finally {
    state.running = false;
    state.finishedAt = performance.now();
    syncButtons();
    scheduleRender();
    flushIdle();
  }
}

function waitIdle() {
  if (!state.running) return Promise.resolve();
  return new Promise((resolve) => state.idleWaiters.push(resolve));
}
function flushIdle() {
  const waiters = state.idleWaiters.splice(0);
  for (const r of waiters) r();
}

/* ============================== 文件入队 ============================== */
function fileKey(file) {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function addFile(file) {
  if (!file || !/\.ncm$/i.test(file.name)) return false;
  const key = fileKey(file);
  if (state.seenKeys.has(key)) return false; // O(1) 去重（原实现是 O(n²) 扫描）
  const id = ++state.seq;
  const entry = {
    id,
    file,
    name: file.name,
    size: file.size,
    status: 'queued',
    progress: 0,
    doneBytes: 0,
    bytesOut: 0,
    outName: '',
    format: '',
    error: null,
    ms: 0,
    blob: null,
    crc32: 0,
    objectUrl: null,
    el: null,
  };
  state.entries.set(id, entry);
  state.order.push(id);
  state.seenKeys.add(key);
  entry.key = key;
  // 批量入场时分帧渲染，避免 500 个文件一次性建 DOM 造成长任务
  state.pendingRows.push(entry);
  scheduleRowRender();
  scheduleRender();
  return true;
}

function addFiles(files) {
  const list = Array.from(files || []);
  let added = 0;
  let ignored = 0;
  for (const f of list) {
    if (addFile(f)) added++;
    else if (!/\.ncm$/i.test(f.name)) ignored++;
  }
  if (ignored) toast(`已忽略 ${ignored} 个非 .ncm 文件`);
  syncButtons();
  if (added > 0 && !state.running) startBatch();
  return added;
}

async function collectEntry(entry, out) {
  if (!entry) return;
  if (entry.isFile) {
    out.push(await new Promise((res, rej) => entry.file(res, rej)));
    return;
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await collectEntry(child, out);
    }
  }
}

/* ============================== 渲染 ============================== */
const ROW_CHUNK = 40; // 每帧最多新建 40 行：500 个文件分 13 帧渲染完，不产生长任务

function scheduleRowRender() {
  if (state.rowRenderScheduled) return;
  state.rowRenderScheduled = true;
  requestAnimationFrame(flushRows);
}

function flushRows() {
  state.rowRenderScheduled = false;
  const rowsEl = $('#rows');
  if (!rowsEl) return;
  const batch = state.pendingRows.splice(0, ROW_CHUNK);
  const frag = document.createDocumentFragment();
  const live = [];
  for (const entry of batch) {
    if (!state.entries.has(entry.id)) continue; // 渲染前被删除
    frag.appendChild(buildRow(entry));
    live.push(entry);
  }
  rowsEl.appendChild(frag);
  for (const entry of live) patchRow(entry);
  if (state.pendingRows.length) scheduleRowRender();
  syncButtons();
  scheduleRender();
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    patchAll();
  });
}

function setText(sel, text) {
  const el = document.querySelector(sel);
  if (el && el.textContent !== text) el.textContent = text;
}

/** 行内图标按钮（DOM API 构建，避免字符串拼 HTML；图标见 template.html sprite） */
function iconBtn(iconId, title, extraClass = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `btn-icon ${extraClass}`.trim();
  btn.title = title;
  btn.setAttribute('aria-label', title);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${iconId}`);
  svg.appendChild(use);
  btn.appendChild(svg);
  return btn;
}

function buildRow(entry) {
  const tr = document.createElement('tr');
  tr.dataset.id = String(entry.id);
  tr.innerHTML = `
    <td class="c-name">
      <div class="row-main">
        <span class="row-icon"><svg class="icon"><use href="#i-music"></use></svg></span>
        <div class="row-text"><div class="fname"></div><div class="fmeta"></div></div>
      </div>
    </td>
    <td class="c-status"><span class="state"><i class="dot"></i><span class="label"></span></span></td>
    <td class="c-progress"><div class="bar"><i></i></div><div class="pct"></div></td>
    <td class="c-out"><span class="out"></span></td>
    <td class="c-act"></td>`;
  entry.el = {
    tr,
    name: tr.querySelector('.fname'),
    meta: tr.querySelector('.fmeta'),
    state: tr.querySelector('.state'),
    stateLabel: tr.querySelector('.state .label'),
    bar: tr.querySelector('.bar > i'),
    pct: tr.querySelector('.pct'),
    out: tr.querySelector('.out'),
    act: tr.querySelector('.c-act'),
  };
  entry.el.name.textContent = entry.name;
  entry.el.name.title = entry.name;
  return tr;
}

function patchRow(entry) {
  const el = entry.el;
  if (!el) return;
  const status = entry.status;
  const label = STATUS_TEXT[status] || status;
  if (el.stateLabel.textContent !== label) el.stateLabel.textContent = label;
  const cls = `state ${status === 'running' ? 'run' : status === 'done' ? 'done' : status === 'error' ? 'err' : ''}`.trim();
  if (el.state.className !== cls) el.state.className = cls;

  const pct = status === 'done' || status === 'error' || status === 'aborted' ? 1 : Math.min(1, entry.progress || 0);
  const width = `${(pct * 100).toFixed(1)}%`;
  if (el.bar.style.width !== width) el.bar.style.width = width;
  el.bar.className = status === 'done' ? 'done' : status === 'error' ? 'err' : '';
  const pctText = status === 'done' ? '100%' : status === 'error' || status === 'aborted' ? '—' : `${Math.round(pct * 100)}%`;
  if (el.pct.textContent !== pctText) el.pct.textContent = pctText;

  const meta = [fmtSize(entry.size)];
  if (entry.format) meta.push(entry.format.toUpperCase());
  if (status === 'done' && entry.ms) meta.push(`${fmtMs(entry.ms)} · ${(entry.bytesOut / 1048576 / (entry.ms / 1000)).toFixed(1)} MB/s`);
  if (status === 'error' && entry.error) meta.push(entry.error);
  const metaText = meta.join(' · ');
  if (el.meta.textContent !== metaText) el.meta.textContent = metaText;

  const outText = entry.outName || '—';
  if (el.out.textContent !== outText) el.out.textContent = outText;
  el.out.title = outText;

  const want = status === 'done' ? 'dl,del' : status === 'error' || status === 'aborted' ? 'retry,del' : 'del';
  if (el.act.dataset.kind !== want) {
    el.act.dataset.kind = want;
    const buttons = [];
    if (want.includes('dl')) buttons.push(iconBtn('i-download', '下载'));
    if (want.includes('retry')) buttons.push(iconBtn('i-refresh', '重试'));
    if (status !== 'running') buttons.push(iconBtn('i-trash', '删除', 'danger'));
    el.act.replaceChildren(...buttons);
    for (const b of buttons) {
      const title = b.title;
      if (title === '下载') b.onclick = () => downloadEntry(entry.id);
      else if (title === '重试') b.onclick = () => retryEntry(entry.id);
      else b.onclick = () => removeEntry(entry.id);
    }
  }
}

function patchAll() {
  for (const id of state.order) {
    const e = state.entries.get(id);
    if (e && e.el) patchRow(e);
  }
  // 总进度
  let totalBytes = 0;
  let doneBytes = 0;
  let doneFiles = 0;
  let failed = 0;
  let outBytes = 0;
  for (const id of state.order) {
    const e = state.entries.get(id);
    if (!e) continue;
    totalBytes += e.size;
    if (e.status === 'done') {
      doneFiles++;
      doneBytes += e.size;
      outBytes += e.bytesOut || 0;
    } else if (e.status === 'running' || e.status === 'queued') {
      doneBytes += Math.min(e.size, (e.progress || 0) * e.size);
    } else if (e.status === 'error') failed++;
  }
  const total = state.order.length;
  const pct = totalBytes > 0 ? Math.min(100, (doneBytes / totalBytes) * 100) : 0;
  const bar = $('#overall-bar');
  bar.style.width = `${pct.toFixed(1)}%`;
  bar.className = !state.running && total > 0 && doneFiles === total ? 'done' : failed ? 'err' : '';
  const elapsed = state.startedAt ? (state.finishedAt || performance.now()) - state.startedAt : 0;
  const speed = elapsed > 0 ? outBytes / (elapsed / 1000) : 0;
  let label;
  if (total === 0) label = '等待文件';
  else if (state.running) label = `${doneFiles}/${total} · ${Math.round(pct)}%${speed > 0 ? ` · ${(speed / 1048576).toFixed(1)} MB/s` : ''}`;
  else label = `${doneFiles}/${total} 完成${failed ? ` · ${failed} 失败` : ''}`;
  if ($('#overall-text').textContent !== label) $('#overall-text').textContent = label;

  // KPI 统计卡片
  setText('#overall-pct', `${Math.round(pct)}%`);
  setText('#stat-files', `${doneFiles} / ${total}`);
  setText('#stat-size', fmtSize(totalBytes));
  setText('#stat-speed', speed > 0 ? `${(speed / 1048576).toFixed(1)} MB/s` : '—');
  setText('#stat-time', elapsed > 0 ? fmtMs(elapsed) : '—');
  setText('#table-hint', total === 0 ? '等待拖入文件' : `${total} 个文件 · ${fmtSize(totalBytes)}`);

  $('#empty').style.display = total === 0 ? '' : 'none';
  const tableCard = $('.table-card');
  if (tableCard) tableCard.classList.toggle('is-empty', total === 0);

  // 完成汇总
  const summaryEl = $('#summary');
  const allSettled = total > 0 && !state.running && doneFiles + failed + countAborted() === total;
  if (allSettled) {
    summaryEl.hidden = false;
    $('#summary-title').textContent = failed ? `转换完成（${failed} 个失败）` : '全部转换完成';
    $('#summary-sub').textContent =
      `${doneFiles} 个文件 · ${fmtSize(totalBytes)} → ${fmtSize(outBytes)}` +
      (elapsed ? ` · 用时 ${fmtMs(elapsed)}` : '') +
      (elapsed > 0 && outBytes > 0 ? ` · 平均 ${(outBytes / 1048576 / (elapsed / 1000)).toFixed(1)} MB/s` : '');
  } else {
    summaryEl.hidden = true;
  }
}

function countAborted() {
  let n = 0;
  for (const id of state.order) if (state.entries.get(id)?.status === 'aborted') n++;
  return n;
}

function syncButtons() {
  const total = state.order.length;
  const hasQueued = state.order.some((id) => ['queued', 'error', 'aborted'].includes(state.entries.get(id)?.status));
  const hasDone = state.order.some((id) => state.entries.get(id)?.status === 'done');
  $('#btn-start').disabled = state.running || !hasQueued;
  $('#btn-cancel').disabled = !state.running;
  $('#btn-download-all').disabled = !hasDone;
  $('#btn-zip').disabled = !hasDone || state.running;
  $('#btn-clear').disabled = total === 0 || state.running;
}

/* ============================== 下载 / ZIP ============================== */
function downloadEntry(id) {
  const entry = state.entries.get(id);
  if (!entry?.blob) return;
  const a = document.createElement('a');
  a.href = entry.objectUrl || URL.createObjectURL(entry.blob);
  a.download = entry.outName || entry.name.replace(/\.ncm$/i, '.mp3');
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadAll() {
  const done = state.order.map((id) => state.entries.get(id)).filter((e) => e?.status === 'done');
  if (!done.length) return;
  if (done.length > 5) toast(`即将下载 ${done.length} 个文件，浏览器可能会询问是否允许多文件下载；也可以改用「打包 ZIP」`);
  for (let i = 0; i < done.length; i++) {
    downloadEntry(done[i].id);
    if (i < done.length - 1) await new Promise((r) => setTimeout(r, 300));
  }
}

async function makeZip() {
  const done = state.order.map((id) => state.entries.get(id)).filter((e) => e?.status === 'done' && e.blob);
  if (!done.length) throw new Error('还没有已完成的文件');
  const t0 = performance.now();
  const names = uniqueZipNames(done.map((e) => e.outName || e.name.replace(/\.ncm$/i, '.mp3')));
  const blob = buildZipBlob(done.map((e, i) => ({ name: names[i], blob: e.blob, crc32: e.crc32 || 0, size: e.bytesOut || e.blob.size })));
  const ms = performance.now() - t0;
  state.zip = { ms, size: blob.size, name: `ncm2mp3-${done.length}files.zip`, entries: done.length };
  return { blob, ms, url: URL.createObjectURL(blob) };
}

async function downloadZip() {
  const btn = $('#btn-zip');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '打包中…';
  try {
    const { url, blob } = await makeZip();
    const a = document.createElement('a');
    a.href = url;
    a.download = `ncm2mp3-${new Date().toISOString().slice(0, 10)}-${state.order.filter((id) => state.entries.get(id)?.status === 'done').length}files.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`已生成 ZIP：${fmtSize(blob.size)}`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.textContent = old;
    syncButtons();
  }
}

/* ============================== 操作 ============================== */
function removeEntry(id) {
  const entry = state.entries.get(id);
  if (!entry || entry.status === 'running') {
    if (entry?.status === 'running') toast('正在转换的文件不能删除');
    return;
  }
  if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  if (entry.key) state.seenKeys.delete(entry.key);
  entry.el?.tr.remove();
  state.entries.delete(id);
  state.order = state.order.filter((x) => x !== id);
  scheduleRender();
}

function retryEntry(id) {
  const entry = state.entries.get(id);
  if (!entry || state.running) return;
  entry.status = 'queued';
  entry.progress = 0;
  entry.error = null;
  startBatch();
}

function cancelAll() {
  if (!state.running) return;
  state.cancelRequested = true;
  if (state.pool) {
    for (const id of state.order) {
      const e = state.entries.get(id);
      if (e && ['queued', 'running'].includes(e.status)) state.pool.abort(id);
    }
    // 所有待取消 id 已标记后再调度，避免取消过程中又启动排队任务
    state.pool.dispatch();
  }
  toast('已请求取消');
}

function clearAll() {
  if (state.running) {
    toast('转换中不能清空');
    return;
  }
  for (const e of state.entries.values()) if (e.objectUrl) URL.revokeObjectURL(e.objectUrl);
  state.entries.clear();
  state.order = [];
  state.pendingRows = [];
  state.rowRenderScheduled = false;
  state.seenKeys.clear();
  state.startedAt = 0;
  state.finishedAt = 0;
  state.usedNames.clear();
  state.summary = null;
  $('#rows').innerHTML = '';
  patchAll();
}

/* ============================== 事件绑定 ============================== */
function bind() {
  const input = $('#file-input');
  const pick = () => input.click();
  $('#btn-pick').onclick = (e) => {
    e.stopPropagation();
    pick();
  };
  const drop = $('#drop');
  drop.onclick = pick;
  drop.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick();
    }
  };
  input.onchange = () => {
    addFiles(input.files);
    input.value = '';
  };

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
    });
  }
  drop.addEventListener('drop', async (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = [];
    if (dt.items && dt.items.length) {
      const entries = [];
      for (const item of dt.items) {
        const en = item.webkitGetAsEntry?.();
        if (en) entries.push(en);
        else {
          const f = item.getAsFile?.();
          if (f) files.push(f);
        }
      }
      for (const en of entries) await collectEntry(en, files);
    } else {
      files.push(...Array.from(dt.files || []));
    }
    addFiles(files);
  });

  $('#btn-start').onclick = () => startBatch();
  $('#btn-cancel').onclick = () => cancelAll();
  $('#btn-load-config').onclick = () => $('#config-input').click();
  $('#config-input').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) await loadConfigFile(f);
    e.target.value = '';
  };
  $('#btn-download-all').onclick = () => downloadAll();
  $('#btn-zip').onclick = () => downloadZip();
  $('#btn-clear').onclick = () => clearAll();
  window.addEventListener('beforeunload', (e) => {
    if (state.running) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* ============================== 自动化钩子（供自检/CI 使用） ============================== */
function getMetrics() {
  const results = state.order.map((id) => state.entries.get(id)).filter(Boolean).map((e) => ({
    name: e.name,
    outName: e.outName,
    inBytes: e.size,
    outBytes: e.bytesOut || 0,
    format: e.format,
    status: e.status,
    ok: e.status === 'done',
    error: e.error || null,
    ms: Math.round(e.ms || 0),
  }));
  const elapsed = state.startedAt ? (state.finishedAt || performance.now()) - state.startedAt : 0;
  const bytesOut = results.reduce((s, r) => s + (r.ok ? r.outBytes : 0), 0);
  return {
    version: '0.0.1',
    mode: state.mode,
    files: state.order.length,
    done: results.filter((r) => r.ok).length,
    failed: results.filter((r) => r.status === 'error').length,
    aborted: results.filter((r) => r.status === 'aborted').length,
    bytesIn: results.reduce((s, r) => s + r.inBytes, 0),
    bytesOut,
    wallMs: Math.round(elapsed),
    throughputMBps: elapsed > 0 ? +(bytesOut / 1048576 / (elapsed / 1000)).toFixed(2) : 0,
    zip: state.zip ? { ...state.zip } : null,
    results,
  };
}

async function sha256Results() {
  const out = [];
  for (const id of state.order) {
    const e = state.entries.get(id);
    if (!e?.blob) continue;
    const buf = await e.blob.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    out.push({ name: e.name, outName: e.outName, bytes: e.blob.size, sha256: hex });
  }
  return out;
}

async function reset() {
  clearAll();
  return true;
}

window.__ncm = {
  version: '0.0.1',
  ready: Promise.resolve(true),
  addFiles: async (files) => addFiles(files),
  start: () => startBatch(),
  setKeys: (core, meta) => {
    const coreEl = $('#key-core');
    const metaEl = $('#key-meta');
    if (coreEl) coreEl.value = String(core ?? '');
    if (metaEl) metaEl.value = String(meta ?? '');
    state.keyText = { core: String(core ?? ''), meta: String(meta ?? '') };
    return true;
  },
  waitIdle,
  reset,
  getMetrics,
  getResults: getMetrics,
  makeZip,
  downloadAll,
  downloadZip,
  sha256Results,
  state,
  get busy() {
    return state.running;
  },
};

/* ============================== 主题 / 快捷键 ============================== */
const THEME_KEY = 'ncm2mp3-theme';

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  const use = document.querySelector('#theme-toggle use');
  if (use) use.setAttribute('href', next === 'dark' ? '#i-sun' : '#i-moon');
  const btn = $('#theme-toggle');
  if (btn) {
    btn.title = next === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    btn.setAttribute('aria-label', btn.title);
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch {
    /* file:// 或隐私模式下可能不可用 */
  }
  let systemDark = false;
  try {
    systemDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch {
    /* ignore */
  }
  applyTheme(saved || (systemDark ? 'dark' : 'light'));
  const btn = $('#theme-toggle');
  if (btn) {
    btn.onclick = () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* ignore */
      }
    };
  }
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', (e) => {
        let override = null;
        try {
          override = localStorage.getItem(THEME_KEY);
        } catch {
          /* ignore */
        }
        if (!override) applyTheme(e.matches ? 'dark' : 'light');
      });
    }
  } catch {
    /* ignore */
  }
}

function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd + O：打开文件选择
    if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      $('#btn-pick')?.click();
    }
  });
}

/* ============================== 启动 ============================== */
function boot() {
  bind();
  initTheme();
  initShortcuts();
  patchAll();
  // 优先尝试读取同目录 config.local.json（HTTP 环境可用；file:// 会自动回退到手动输入）
  void tryAutoLoadConfig();
  // 若浏览器完全禁用了 Worker，启动时提示一次（不阻塞使用）
  if (!canUseWorker()) {
    console.info('[ncm] 当前环境不支持 Worker，已自动使用主线程分片模式');
  }
  window.__ncm.ready = Promise.resolve(true);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
