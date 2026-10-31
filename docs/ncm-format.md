# NCM 文件格式结构说明

> 版本：2.0
> 适用：常见 `.ncm` 容器（含 3.x 带封面 padding 的变体）
> 范围：本文只描述文件结构、字段语义与格式嗅探，不包含密钥、解密算法或可运行代码。
> 解密所需的密钥由使用者自行提供，本仓库不提供、不分发任何密钥。

## 1. 总览

`.ncm` 是一种容器格式：文件由固定头部、若干长度前缀的段、封面图片与音频负载组成。
头部字段均为小端序（little-endian）。常见布局如下：

| 偏移 | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 8 | magic | 固定字符串 `CTENFDAM` |
| 8 | 2 | gap | 保留字节，通常为 `01 70` |
| 10 | 4 | key_len | 后续 key 段的字节数（u32） |
| 14 | key_len | key 段 | 定长块结构，含长度前缀与密钥材料 |
| 14 + key_len | 4 | meta_len | 后续 meta 段的字节数（u32） |
| 18 + key_len | meta_len | meta 段 | 元信息容器（可能为空） |
| 18 + key_len + meta_len | 4 | crc32 | 音频校验值；解析器通常不校验 |
| 22 + key_len + meta_len | 1 | image_ver | 封面版本标记 |
| 23 + key_len + meta_len | 4 | cover_frame_len | 封面帧总长（图片 + 对齐 padding，u32） |
| 27 + key_len + meta_len | 4 | cover_len | 封面图片本身的长度（u32） |
| 31 + key_len + meta_len | cover_len | cover | 封面图片字节（JPEG / PNG） |
| … | cover_frame_len - cover_len | padding | 封面帧尾部对齐字节 |
| audio_offset | 文件末尾 | audio | 音频负载（加密后的容器数据） |

音频起始偏移：

```
audio_offset = 31 + key_len + meta_len + cover_frame_len
```

## 2. 字段与段

- **key 段**：长度由 `key_len` 给出，按固定块大小对齐；其内容需使用使用者提供的核心密钥解析。
- **meta 段**：长度由 `meta_len` 给出，可为 0；解析失败时可按“无元信息”处理。
- **元信息**：成功解析后为 JSON，常见字段包括 `musicName`、`artist`（嵌套数组）、`album`、
  `format` 等；字段缺失或类型异常时应回退到原文件名。
- **封面**：`cover_frame_len` 是封面帧的总长度，`cover_len` 是图片本身长度；
  两者之差为对齐 padding。旧客户端可能没有 padding（两者相等），新客户端通常有。
- **音频**：从 `audio_offset` 到文件末尾；负载格式需通过首块字节嗅探，不能直接信任元信息里的 `format`。

## 3. 格式嗅探

解析器在音频起始位置读取若干字节，按魔数判断真实格式：

| 格式 | 起始字节特征 |
|---|---|
| MP3（ID3） | `49 44 33`（`ID3`） |
| MP3（帧同步） | 首字节 `FF`，次字节高 3 位为 `111` |
| FLAC | `66 4C 61 43`（`fLaC`） |
| OGG | `4F 67 67 53`（`OggS`） |
| WAV | `52 49 46 46`（`RIFF`）且偏移 8 处为 `WAVE` |
| M4A | 偏移 4 处为 `66 74 79 70`（`ftyp`） |
| 未知 | 保留原扩展名或输出为 `.bin` |

## 4. 解析注意事项

- **长度边界**：解析前必须校验 `key_len`、`meta_len`、`cover_frame_len`、`cover_len`，
  拒绝超过实现上限（本仓库取 64 MiB/段）或 `cover_len > cover_frame_len` 的头部。
- **截断头部**：流式读取时应先读一段前缀（例如 1 MiB），不足时按需扩容；
  头部字段完整后再跳到 `audio_offset`，避免把封面读入内存。
- **CRC 字段**：位于 meta 段之后，部分文件填 0；本仓库不将其作为完整性依据，
  音频字节校验由测试与 ZIP 的 CRC32 负责。
- **无元信息文件**：`meta_len = 0` 或解析失败时，输出名回退到原文件名（去 `.ncm`，补输出扩展名）。
- **文件名清洗**：输出名需移除 Windows 非法字符与控制字符，并限制长度。

## 5. 参考实现

以下开源项目实现了该格式的读取与转换，可作为交叉验证参考（各项目许可证以各自仓库为准，本文不复制其代码）：

- `taurusxin/ncmdump`（C++）
- `unlock-music`（TypeScript）
- `ncm2mp3-core`（Rust）
- `0x77fe/AudioDecrypt`（C++）

## 6. 测试与验证

本仓库的测试样本由 `tools/make-fixtures.mjs` 合成生成：

- 音频为确定性随机字节，仅伪造容器魔数与头部字段；
- 元信息为虚构示例值（`Test Artist` / `Test Song` / `Example Album` 等）；
- 解密使用测试专用密钥（`tools/test-keys.mjs`），与真实平台密钥无关；
- 生成后立即用 `src/ncm.js` 回读，与 `.expected.*` 逐字节比对。

```bash
node tools/make-fixtures.mjs --out fixtures --profile default
node tests/roundtrip.mjs
node tests/limits.mjs
```

## 7. 变更记录

- **2.0**：移除密钥、算法细节与逐字代码引用，改为结构说明；解密密钥改由使用者提供。
- **1.x**：早期版本包含密钥与实现细节，已不再随仓库提供。
