# 第三方组件与许可证声明（THIRD-PARTY NOTICES）

本项目（NCM → MP3 批量转换，单文件本地版）包含以下 MIT 许可的第三方作品。
**本文件、构建产物 `ncm2mp3-batch.html` 顶部的 HTML 注释、以及页面页脚「开源许可与致谢」三处均保留相同声明。**

> MIT 许可证要求：在软件的所有副本或实质部分中保留版权声明与许可声明。
> 本项目分发的 `ncm2mp3-batch.html` 是单个文件，因此两份 MIT 全文直接内嵌在该文件顶部的 HTML 注释中，
> 随文件一起分发，满足要求。

---

## 1. UI 设计参考：Tabler

| 项 | 内容 |
|---|---|
| 名称 | Tabler（后台管理模板 / 设计系统） |
| 仓库 | https://github.com/tabler/tabler |
| 版本 | **v1.7.3**（release tag：`@tabler/core@1.7.3`，发布于 2026-10-29） |
| 参考 commit | `096491dea4886f78891c2e29310351d5aee6c460`（2026-10-29） |
| 作者/版权 | Copyright (c) 2018-2026 **The Tabler Authors** |
| 许可证 | **MIT License**（全文见 §3） |
| 使用的部分 | 仅作为**视觉与布局设计参考**：卡片、KPI 统计、表格、状态徽标、进度条、按钮层级、浅/深色配色与间距节奏 |
| 是否复制代码 | **否**。项目未复制 Tabler/Bootstrap 的 CSS 规则，也未引入其 JS；所有样式为本项目按设计语言重写 |
| 修改说明 | 无代码复制，故无修改；页面在视觉上做了简化与单文件适配（Modified design interpretation） |
| 分发形式 | 不作为独立包分发；仅存在于本项目自写的 CSS 中 |

> 尽管本项目对 Tabler 属于「设计参考」而非复制，仍主动保留此致谢与许可证，避免任何歧义。

---

## 2. 图标：Tabler Icons

| 项 | 内容 |
|---|---|
| 名称 | Tabler Icons（SVG 图标库） |
| 仓库 | https://github.com/tabler/tabler-icons |
| 版本 | **v3.50.0**（发布于 2026-10-27） |
| 参考 commit | `6904efd245391ad396df17654738f52f6da8c40e`（v3.50.0 的 target commit） |
| 作者/版权 | Copyright (c) 2020-2026 **Paweł Kuna** |
| 许可证 | **MIT License**（全文见 §3） |
| 使用的部分 | 11 个图标：`music`、`cloud-upload`、`folder`、`download`、`package`、`refresh`、`x`、`trash`、`check`、`sun`、`moon` |
| 使用方式 | 图标 SVG 内的 `<path>` 数据原样复制，合并为一个 `<symbol>` sprite（`src/template.html` 中 `<svg class="sprite">`），通过 `<use href="#i-…">` 引用 |
| 修改说明 | **仅做 sprite 合并**（把独立 `<svg>` 改写为 `<symbol viewBox="0 0 24 24">`），图形路径、描边参数（stroke-width=2, round）未改 |
| 分发形式 | 内联在 `ncm2mp3-batch.html` 中随文件分发；MIT 许可全文见该文件顶部注释 |

---

## 3. MIT 许可证全文

### 3.1 Tabler

```
MIT License

Copyright (c) 2018-2026 The Tabler Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 3.2 Tabler Icons

```
MIT License

Copyright (c) 2020-2026 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 4. 合规自查清单

| MIT 要求 | 本项目落实位置 | 结论 |
|---|---|---|
| 保留版权声明 | `ncm2mp3-batch.html` 顶部注释；本文件 §3；页面页脚 | ✅ |
| 保留许可声明（全文） | `ncm2mp3-batch.html` 顶部注释；本文件 §3 | ✅ |
| 在「所有副本或实质部分」中包含 | 成品是单文件，声明直接内嵌其中，随文件复制分发 | ✅ |
| 修改需说明 | Tabler Icons 仅 sprite 合并已在 §2 注明；Tabler 无代码复制 | ✅ |
| 不得使用作者名义背书 | 未使用其商标/Logo；页脚仅作事实性致谢 | ✅ |
| 与其它许可证兼容 | 全部为 MIT，无 copyleft；本项目自身未引入 GPL/AGPL/CC-BY-NC | ✅ |

**验证方法**

```bash
# 1) 构建产物中是否包含两份许可证声明（应输出 2）
grep -c "MIT License — Tabler" ncm2mp3-batch.html

# 2) 页面中是否包含版权与版本标注
grep -o "Tabler Icons</a> v3.50.0" ncm2mp3-batch.html

# 3) 构建产物是否仍为零外部依赖（应为 0 个外部 script/css 引用）
grep -c '<script src=' ncm2mp3-batch.html
grep -c 'href="https://' ncm2mp3-batch.html   # 仅页脚致谢链接（用户点击才访问，不影响离线）
```

---

## 5. 未引入的第三方组件（说明）

为保持「单文件 / 离线 / 零依赖」，本项目**没有**引入 Bootstrap、Tabler 的 JS、jQuery、任何 CSS 框架运行时、
任何 CDN 资源或 Web 字体。图标是本项目唯一的复制型第三方内容（见 §2），其余 UI 样式均为本项目原创实现。
