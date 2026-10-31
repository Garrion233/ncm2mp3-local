# 架构说明

单文件版（`ncm2mp3-batch.html`）由 `src/` 下 6 个 JS 模块 + 1 个 HTML 模板经
`tools/build-single.mjs` 内联打包而成。以下说明其运行结构与关键实现。

---

## 1. 数据流

```
┌──────────────────────── 主线程（只做 UI） ────────────────────────┐
│ 拖放/选择 → 文件队列（去重） → Worker 池调度（并发 = min(2, CPU-1)）│
│      │                                    ▲ progress / meta / done │
│      ▼                                    │                          │
│  rAF 节流渲染（只 patch 变化单元格） ← 进度聚合                     │
│      │                                                              │
│      ▼                                                              │
│  完成的 Blob → 下载 / STORE 模式 ZIP（Blob 零拷贝拼装）             │
└─────────────────────────────────────────────────────────────────────┘
                            │ File（结构化克隆，零拷贝）
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ Worker #1     │   │ Worker #2     │…  │ Worker #N     │
│ File.slice    │   │               │   │               │
│  4MiB/块      │   │               │   │               │
│   ↓           │   │               │   │               │
│ probeHeader   │ ← 只读头部几 KB，按需扩容；封面只按长度跳过      │
│ createDecoder │ ← 用音频前 64KB 嗅探真实格式 + 选密钥材料变体   │
│ transformIn   │ ← 绝对偏移密钥流，块长任意                   │
│ Place(chunk)  │   │               │   │               │
│ crc32Update   │ ← 解码同遍增量算 CRC（给 ZIP 用）            │
│ new Blob(parts)│ ← 交给主线程只是句柄，不复制字节             │
└───────────────┘   └───────────────┘   └───────────────┘
```

**主线程搬运的音频字节数：0。**

## 2. Worker 协议（`src/worker.js` ↔ `src/final-app.js`）

主 → Worker：

```jsonc
{ "type": "convert", "id": 12, "file": File, "chunkSize": 4194304 }
{ "type": "abort",   "id": 12 }
{ "type": "ping",    "id": 0 }
```

Worker → 主：

```jsonc
{ "type": "meta",     "id": 12, "outputName": "示例歌手 - 示例歌曲.mp3", "format": "mp3",
  "metadata": {...}, "audioTotal": 6291456, "keyVariant": "unpadded" }
{ "type": "progress", "id": 12, "done": 4194304, "total": 6291456, "elapsedMs": 41 }
{ "type": "done",     "id": 12, "blob": Blob, "outputName": "...", "size": 6291456,
  "crc32": 305419896, "format": "mp3", "ms": 41 }
{ "type": "error",    "id": 12, "code": "BAD_MAGIC", "message": "..." }
{ "type": "aborted",  "id": 12 }
```

* 进度消息按 120ms 节流，避免小分块时的消息风暴；
* 每个 chunk 之后 `await Promise.resolve()` 让出 Worker 事件循环，使 `abort` 能及时生效；
* 池中每个 Worker 同时只处理一个文件，避免"每个文件一个线程"的资源爆炸；
* 主线程侧对 Worker 消息处理加了 try/finally：UI 层异常不会把批次卡死。

## 3. 降级模式（`src/final-app.js`）

`file://` 下 Worker 用 Blob URL 创建（打包器注入 `__NCM_WORKER_FACTORY__`）。
若环境完全禁用 Worker，`canUseWorker()` 返回 false，自动切换到主线程分片模式：

* 每 2 MiB 一块，解密后立即 `await setTimeout(0)` 让出事件循环；
* 页面仍可交互（实测 4 文件 144ms、最大帧间隔 16.8ms）；
* 代价是吞吐略低，但不会出现长时间"无响应"。

可用 `?mainthread=1` 强制走这条路径（验证用）。

## 4. NCM 解析要点

* 容器字段与布局见 [`ncm-format.md`](./ncm-format.md)；解析器只负责结构解析，
  解密所需的密钥由使用者在页面本地提供，程序不内置密钥。
* 音频负载在 Worker 内按绝对偏移流式处理，支持任意块长；具体实现位于 `src/ncm.js`。
* 通过音频开头的魔数嗅探真实格式；嗅探失败时回退到元信息中的 `format` 提示。

## 5. ZIP（`src/zip.js`）

* STORE（method=0）不压缩：MP3/FLAC 已是压缩格式，DEFLATE 收益≈0；
* 解码时**顺路**算 CRC32，ZIP 阶段不重读数据；
* 用 Blob 引用拼装：`new Blob([localHeader, audioBlob, …, centralDir, eocd])`，
  浏览器零拷贝组装，主线程不搬运音频字节（41.6MB / 8 文件实测 2.2ms）；
* 非 ZIP64：单文件/总大小 ≤4GB、条目 ≤65535，超限明确报错。

## 6. 内存与边界

* 每 Worker 峰值 ≈ `chunkSize`(4MiB) + 输出 Blob；在途数据 ≈ 2 × 4MiB（并发上限 2）；
* 输入 `File` 是磁盘句柄，不因"投入 200 个文件"而全部读入内存；
* 输出 Blob 常驻到下载/删除；「清空」会 revoke ObjectURL 并释放引用；
* 边界：超大单文件（>1GB）建议用 `cli.mjs` 流式写盘；`longtask` 指标在 Safari 不支持（页面会静默降级）。

## 7. 构建与验证

```bash
node tools/build-single.mjs    # src/ → ncm2mp3-batch.html（内联 Worker + 语法检查）
node tools/verify-single.mjs   # 真实 Chrome + file://，17 项端到端检查
node tests/roundtrip.mjs       # 字节级正确性 + 9 种块长一致性
```
