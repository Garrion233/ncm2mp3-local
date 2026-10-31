#!/usr/bin/env node
/**
 * 批量 CLI：把目录里的 .ncm 批量转成 mp3/flac（Node，多线程，流式）。
 *
 *   node cli.mjs <文件|目录>... --out <输出目录> [选项]
 *
 * 选项：
 *   --out, -o <dir>     输出目录（默认 ./out）
 *   --recursive, -r     递归子目录
 *   --workers, -w <n>   并发线程数（默认 min(8, CPU-1)）
 *   --chunk <bytes>     分块大小（默认 4MiB）
 *   --overwrite         覆盖同名输出（默认自动改名）
 *   --core-key <text>   核心密钥（16 字节 ASCII 或 32 位十六进制；也可用 NCM_CORE_KEY）
 *   --meta-key <text>   元数据密钥（16 字节 ASCII 或 32 位十六进制；也可用 NCM_META_KEY）
 *   优先级：命令行参数 > 环境变量 > 项目根目录 config.local.json（本地私有，gitignore）
 *   --quiet             只输出汇总
 *   --json <file>       把结果写成 JSON 报告
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { loadLocalConfig } from './tools/load-config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKER_URL = new URL('./tools/cli-worker.mjs', import.meta.url);

function parseArgs(argv) {
  const o = { inputs: [], out: path.resolve('out'), recursive: false, workers: 0, chunk: 4 * 1024 * 1024, overwrite: false, quiet: false, json: null, coreKey: process.env.NCM_CORE_KEY || '', metaKey: process.env.NCM_META_KEY || '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') o.out = path.resolve(argv[++i]);
    else if (a === '--recursive' || a === '-r') o.recursive = true;
    else if (a === '--workers' || a === '-w') o.workers = Number(argv[++i]) || 0;
    else if (a === '--chunk') o.chunk = Number(argv[++i]) || o.chunk;
    else if (a === '--overwrite') o.overwrite = true;
    else if (a === '--core-key') o.coreKey = argv[++i] || '';
    else if (a === '--meta-key') o.metaKey = argv[++i] || '';
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--json') o.json = path.resolve(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
      process.exit(0);
    } else if (a.startsWith('-')) {
      console.error('未知参数:', a);
      process.exit(2);
    } else {
      o.inputs.push(path.resolve(a));
    }
  }
  if (o.inputs.length === 0) o.inputs.push(process.cwd());
  if (!o.coreKey || !o.metaKey) {
    const cfg = loadLocalConfig();
    if (cfg) {
      if (!o.coreKey) o.coreKey = cfg.CORE_KEY;
      if (!o.metaKey) o.metaKey = cfg.META_KEY;
    }
  }
  if (!o.coreKey || !o.metaKey) {
    console.error('请提供本地合法的解密密钥：--core-key / --meta-key、环境变量 NCM_CORE_KEY / NCM_META_KEY，或项目根目录 config.local.json');
    process.exit(2);
  }
  if (!o.workers) o.workers = Math.max(1, Math.min(8, os.cpus().length - 1));
  return o;
}

async function collectFiles(inputs, recursive) {
  const out = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (recursive) await walk(full);
      } else if (ent.isFile() && /\.ncm$/i.test(ent.name)) {
        out.push(full);
      }
    }
  }

  for (const input of inputs) {
    let stat;
    try {
      stat = await fsp.stat(input);
    } catch {
      console.error('路径不存在:', input);
      continue;
    }
    if (stat.isFile()) {
      if (/\.ncm$/i.test(input)) out.push(input);
    } else if (stat.isDirectory()) {
      await walk(input);
    }
  }
  // 去重
  return [...new Set(out)];
}

function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 ** 2) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + ' MB';
  return (b / 1024 ** 3).toFixed(2) + ' GB';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const files = await collectFiles(opts.inputs, opts.recursive);
  if (files.length === 0) {
    console.error('没有找到 .ncm 文件');
    process.exit(1);
  }
  if (!opts.quiet) {
    console.log('');
    console.log(`  待转换 ${files.length} 个文件，${fmtSize(files.reduce((s, f) => s + fs.statSync(f).size, 0))}`);
    console.log(`  输出目录 ${opts.out}`);
    console.log(`  并发 ${opts.workers} 线程 · 分块 ${fmtSize(opts.chunk)}`);
    console.log('');
  }

  const results = new Array(files.length);
  let nextIndex = 0;
  let finished = 0;
  let totalOut = 0;
  let totalIn = 0;
  const sizes = files.map((f) => fs.statSync(f).size);

  const draw = () => {
    if (opts.quiet) return;
    const pct = ((finished / files.length) * 100).toFixed(0);
    process.stdout.write(`\r  进度 ${finished}/${files.length} (${pct}%)  输出 ${fmtSize(totalOut)}   `);
  };

  const runWorker = () =>
    new Promise((resolve) => {
      const worker = new Worker(WORKER_URL, {
        workerData: { chunkSize: opts.chunk, keys: { core: opts.coreKey, meta: opts.metaKey } },
        stdout: true,
        stderr: true,
      });
      let current = null;
      const job = () => {
        if (nextIndex >= files.length) {
          worker.postMessage({ type: 'exit' });
          resolve();
          return;
        }
        const i = nextIndex++;
        current = i;
        totalIn += sizes[i] || 0;
        worker.postMessage({ type: 'job', id: i, payload: { filePath: files[i], outDir: opts.out, overwrite: opts.overwrite } });
      };
      worker.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'result') {
          results[msg.id] = msg.result;
          finished++;
          if (msg.result.ok) totalOut += msg.result.bytesOut;
          else {
            process.stdout.write('\n');
            console.error(`  ✗ ${path.basename(files[msg.id])}: ${msg.result.error}`);
          }
          if (!opts.quiet) {
            const r = msg.result;
            const name = path.basename(files[msg.id]);
            if (r.ok) {
              const speed = (r.bytesOut / 1024 / 1024 / (r.ms / 1000)).toFixed(1);
              process.stdout.write('\n');
              console.log(`  ✓ ${name} → ${path.basename(r.outPath)}  [${r.format.toUpperCase()} ${fmtSize(r.bytesOut)} ${speed} MB/s]`);
            }
          }
          draw();
          job();
        } else if (msg.type === 'progress') {
          if (!opts.quiet) draw();
        }
      });
      worker.on('error', (e) => {
        console.error('\n工作线程异常:', e.message);
        if (current !== null) {
          results[current] = { ok: false, filePath: files[current], error: e.message };
          finished++;
        }
        resolve();
      });
      job();
    });

  await Promise.all(Array.from({ length: Math.min(opts.workers, files.length) }, runWorker));

  const ok = results.filter((r) => r && r.ok).length;
  const failed = results.filter((r) => r && !r.ok).length;
  const elapsed = (Date.now() - started) / 1000;
  if (!opts.quiet) process.stdout.write('\n');
  console.log('');
  console.log(`  完成：成功 ${ok}，失败 ${failed}，用时 ${elapsed.toFixed(2)}s，` +
    `吞吐 ${(totalOut / 1024 / 1024 / Math.max(0.001, elapsed)).toFixed(1)} MB/s（输出字节）`);
  console.log(`  输入 ${fmtSize(totalIn)} → 输出 ${fmtSize(totalOut)}`);
  console.log('');

  if (opts.json) {
    await fsp.writeFile(opts.json, JSON.stringify({ startedAt: new Date(started).toISOString(), elapsedSec: +elapsed.toFixed(3), ok, failed, results }, null, 2), 'utf8');
    console.log('  JSON 报告:', opts.json);
  }
  process.exit(failed > 0 && ok === 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('CLI 失败:', e);
  process.exit(1);
});
