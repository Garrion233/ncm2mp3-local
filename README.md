# NCM → MP3 / FLAC 批量转换

[![CI](https://github.com/Garrion233/ncm2mp3-local/actions/workflows/ci.yml/badge.svg)](https://github.com/Garrion233/ncm2mp3-local/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

单文件、离线、零依赖的 NCM 批量转换工具，支持将第三方音乐平台客户端下载的 `.ncm` 文件批量转换为 MP3 / FLAC。
转换在 Worker 池中执行，主线程仅处理界面更新，批量处理期间页面保持可操作。

![界面截图](docs/screenshot.png)

## 项目简介

项目以单个 HTML 文件分发，双击即可在浏览器中打开，将 `.ncm` 文件批量转换为 MP3 或 FLAC。

- **单文件分发**：整个应用是一个约 125 KB 的 HTML 文件，无需安装、无需服务器、无需联网；
- **格式保真**：原始音频为 MP3 时输出 MP3，为 FLAC 时输出 FLAC（不重新编码）；
- **批量处理**：支持多选、拖入整个文件夹、打包 ZIP 下载；
- **线程模型**：解密、CRC、Blob 组装在 Worker 池内完成，主线程不处理音频字节；
- **本地密钥**：解密所需的两个 16 字节密钥由使用者在页面输入，不随程序分发、不写入磁盘；
- **主题与快捷键**：浅色/深色主题跟随系统并可记忆，`Ctrl/Cmd + O` 快速选择文件。

## 使用方式

### 直接使用

1. 双击 `ncm2mp3-batch.html`，或将其拖入 Chrome / Edge / Firefox 窗口；
2. 将 `.ncm` 文件拖入页面（支持多选，也支持整个文件夹）；
3. 在「解密密钥」区域填入本地合法密钥（核心密钥、元数据密钥各一个）；
4. 转换完成后选择「下载全部」，或选择「打包 ZIP」一次性下载。

该 HTML 文件可独立分发，无需安装依赖。

### 解密密钥

页面需要两个 16 字节密钥（核心密钥、元数据密钥），可输入 16 字节 ASCII 或 32 位十六进制。
密钥仅保存在当前页面内存中，不上传、不写入磁盘。未提供密钥时，页面会提示
「请提供本地合法的解密密钥」，并不会开始转换。

密钥请通过合法途径自行取得；本仓库不提供、不分发任何密钥。

### 本地配置文件（可选）

- 将 [`config.example.json`](config.example.json) 复制为 `config.local.json`，填入本地合法密钥；
- **Node CLI**：自动读取项目根目录的 `config.local.json`（优先级低于命令行参数/环境变量）；
- **浏览器**：通过 HTTP 打开页面时会自动尝试读取同目录 `config.local.json`；`file://` 下浏览器禁止本地
  `fetch`，可点击页面上的「载入本地配置」选择该文件；
- `config.local.json` 已加入 `.gitignore`，**绝不进入 Git 历史**；仓库只提交占位模板 `config.example.json`。

### 从源码构建

需要 Node.js ≥ 20（仅构建与测试需要，最终用户不需要）。

```bash
node tools/build-single.mjs        # src/ → ncm2mp3-batch.html
node tools/verify-single.mjs       # 真实 Chrome + file:// 端到端验证（17 项）
```

### 命令行批量转换

```bash
node cli.mjs <目录或文件> --out ./out -w 8 \
  --core-key <16 字节核心密钥> --meta-key <16 字节元数据密钥>
```

流式读写、多线程，适用于大目录或单文件 >1 GB 的场景。CLI 也支持环境变量
`NCM_CORE_KEY` / `NCM_META_KEY`；未提供密钥时会直接报错退出。

## 构建与测试

```bash
# 生成确定性测试样本（约 42 MB）
node tools/make-fixtures.mjs --out fixtures --profile default

node tests/roundtrip.mjs      # 字节级往返 + 9 种块长一致性（107 项）
node tests/limits.mjs         # ZIP 4 GiB / 65,535 条目边界（10 项）
node tools/build-single.mjs   # 构建单文件（CI 校验与已提交产物一致）
node tools/verify-single.mjs  # 真实浏览器端到端（需要 Chrome，可选）
```

## 使用说明

- 浏览器可能询问是否允许下载多个文件，选择允许即可；文件较多时建议使用「打包 ZIP」。
- 文件名自动按「歌手 - 歌名」命名；原始音频为 MP3 时输出 MP3，为 FLAC 时输出 FLAC。
- 单个 ZIP 上限为 4 GB，超过时请分批「下载全部」。
- 支持 Chrome / Edge 90+、Firefox 90+、Safari 16+。
- 界面支持浅色/深色主题（默认跟随系统，可通过右上角按钮切换）；`Ctrl+O`（macOS 为 `⌘+O`）用于快速选择文件。
- 界面设计参考 Tabler（MIT），图标来自 Tabler Icons（MIT），许可证全文见页面源码顶部注释与「开源许可与致谢」。

## 性能与容量建议

42 MB（8 个文件）在 Chrome 156 headless 环境下：总耗时 130 ms，长任务 0 次，最大帧间隔 16.7 ms，ZIP 打包 2.2 ms；
单文件 1.5 GB 实测 7.2 s；800 MB 批量（100 个文件）约 1.4 s。

- **单文件**：实测 1.5 GB 可正常转换（约 7 秒）；建议单文件不超过 1 GB，内存 8 GB 的机器建议不超过 300–500 MB。更大的文件建议使用命令行版 `cli.mjs`。
- **一批文件**：实测 100 个文件正常（仅入场时出现约 0.1 秒的一次性停顿），建议每批不超过 100 个。
- **文件较多时**：建议使用「打包 ZIP」而非「下载全部」；后者逐个下载、间隔 0.3 秒，500 个文件约需 2.5 分钟。
- **响应速度**：单文件转换期间页面仍可操作。

完整测试环境、数据与局限见 [`docs/performance.md`](docs/performance.md)。

## 常见问题

**Q: 提示“文件格式不正确”？**
A: 仅支持第三方音乐平台客户端下载的 `.ncm` 文件（加密容器）。其他格式或损坏文件会给出具体错误。

**Q: 页面空白或无响应？**
A: 请使用较新的 Chrome / Edge / Firefox。完全禁用 JavaScript 的浏览器无法运行本工具。

**Q: 转换后无法播放？**
A: 请确认原始文件本身完整，可从原始下载平台重新获取。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 架构、Worker 协议、ZIP 设计、内存模型 |
| [`docs/ncm-format.md`](docs/ncm-format.md) | NCM 容器结构、字段语义、格式嗅探 |
| [`docs/performance.md`](docs/performance.md) | 性能测试方法、数据、容量边界 |
| [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md) | 第三方组件与 MIT 许可证全文 |

## CI

GitHub Actions 在 Node 20/22 上执行：构建单文件 → 校验产物可复现 → 生成测试样本 →
往返测试（107 项）→ ZIP 边界测试（10 项）→ CLI 冒烟测试 → 上传构建产物。

## 合规与免责声明

1. **技术交流用途**：本项目（包含所有源码、文档及构建产物）用于计算机科学、数据格式解析及前端技术的学习与交流。**请勿用于侵犯版权或盗版传播等违法违规用途**。
2. **不提供版权内容**：本仓库不包含、不提供、也不分发任何受版权保护的音乐或音频文件。仓库中的测试样本仅包含无意义的二进制数据，不包含任何真实音频。
3. **合法来源要求**：本工具仅作本地文件格式解析的技术演示。使用前应确保待转换的 `.ncm` 文件系通过合法途径（如官方平台购买数字专辑）获取，并拥有合法使用权。
4. **合规声明**：本项目仅用于计算机文件格式分析与前端技术交流。用户需自行确保拥有音频文件的合法使用权，并自行提供解密所需的密钥。因使用本工具产生的任何法律纠纷与开发者无关。
5. **责任豁免**：因使用或误用本工具（包括但不限于将转换后的音频用于二次分发、网络传播、商业牟利等）产生的一切法律责任、版权纠纷及平台违约风险，均由使用者自行承担。本项目的开发者及贡献者不承担任何直接或间接的法律责任。
6. **遵守平台协议**：使用时须遵守所在地区的法律法规，以及相关音乐平台的《用户服务协议》。

**Disclaimer (English)**: This project performs local format conversion only. It does not include,
host, or distribute any music content, lyrics, or third-party site code. Use it only with files you
legally own, and comply with the laws of your jurisdiction and the music platform's terms of service.
No affiliation with any music platform or third-party site. Use at your own risk.

## 开源协议

本项目基于 [MIT License](LICENSE) 协议开源。

UI 设计参考 **Tabler**（MIT，© 2018–2026 The Tabler Authors，v1.7.3），
图标来自 **Tabler Icons**（MIT，© 2020–2026 Paweł Kuna，v3.50.0）；
版权、版本、commit 与修改说明见 [`docs/THIRD_PARTY_NOTICES.md`](docs/THIRD_PARTY_NOTICES.md)。

---

*版本：v0.0.1*
