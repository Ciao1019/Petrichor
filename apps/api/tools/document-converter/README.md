# petrichor-doc-convert

服务端单源、离线 Markdown 转换 CLI，MSRV **Rust 1.88**。只接受一个本地绝对路径，
不读取 URL、外部关系目标、配置或凭据，不执行宏/公式，不运行 OCR。

```sh
petrichor-doc-convert --input /absolute/file --format docx
petrichor-doc-convert --version
```

`--format` 大小写不敏感，白名单为：
`doc docx docm odt pdf ppt pps pot pptx pptm ppsx ppsm rtf epub xlsx xlsm xlsb xls ods odp csv`。
`md/markdown` 由 Go 原样处理，这里返回 `unsupported`。输入路径的扩展名不参与格式选择。

## 协议

stdout 为单个 JSON 加换行（`--version` 除外）：

```json
{"ok":true,"markdown":"...","engine":"anydoc"}
{"ok":true,"markdown":"...","engine":"calamine"}
{"ok":false,"code":"needsOcr","pages":[1],"pageCount":1}
{"ok":false,"code":"malformed"}
```

失败码：`needsOcr unsupported malformed encrypted resourceLimit missingPart io`。
业务失败退出 **0**，没有错误详情、输入路径或正文片段；只有 `needsOcr` 携带页码字段。
参数错误退出 **2**、stdout 为空，stderr 固定为 `invalid arguments`；stdout 写入失败退出 2，
stderr 固定为 `output unavailable`。第三方 panic 被脱敏并映射为 `malformed`；
OOM、超时、信号退出仍必须由父进程处理，不能假装得到完整 JSON。

PDF 输入必须已经由 Go 拆成单页；多页返回 `unsupported`。只有页面树有效且单页字典完全没有
`Contents`、`Annots` 键时返回空 Markdown。空流、Null、空数组、批注不被当作结构性空白；
其结果沿用 anydoc 的真实分类，绝不把 `unsupported` 改写为 `needsOcr`。
OCR 页码仅在上游确认 `pages=[1], pageCount=1` 时输出。

## 引擎与边界

- XLS/XLSB 使用 **Calamine 0.36.1**，不使用 anydoc 的旧二进制 Excel 实现。
  逐个 `sheet_names()` / `worksheet_range()` 读取，任何表失败都会使整个转换失败，
  不使用会忽略失败表的 `worksheets()`。XLS 的兼容层仅规范物理扇区外的旧式 FAT 填充；
  XLSB 的兼容层将七类短单元格补齐为完整记录，保留隐含列位置、样式字段及缓存值。
  兼容后仍验证数据链、加密、ZIP/记录结构和资源上限。
- XLSX/XLSM 的隐藏表、隐藏行/列及缺失公式缓存会被预检拒绝，避免 anydoc 漏读内容。
  XLSB 的 `BrtFmlaError` 错误公式缓存仍不支持；不会将已确认的遗漏当作转换成功。
- 所有 XLS/XLSB 数据表（含隐藏、空表）都输出二级标题；空表标记为 `（空表）`。
  有数据表从 A1 到最后数据单元格展开，保留起始/中间空列和空行；不渲染数据范围外仅有样式的空格。
  第一行作为 GFM 表头，不推断/删除业务行。文本转义 GFM/HTML，空格和 Tab 使用实体，换行使用 `<br>`。
- 包含整数、浮点、布尔、错误、空值、日期和时长类型；公式只读取缓存值。
  Excel 数值日期/时长保留 Calamine 的序列数，不猜测显示格式，ISO 日期/时长保留原值；
  不复制样式、图表、图片或宏，也不宣称对电子表格原版式无损。
- 其他格式使用 **anydoc 0.2.4**。额外固定 `pdf-inspector=1.14.2`、`lopdf=0.42.0`，
  与 anydoc 官方锁文件保持同一 PDF 解析核心。

| 限制 | 值 |
| --- | --- |
| 单源大小 | 100 MiB（100 × 1024 × 1024 字节） |
| 每次转换 Markdown UTF-8 字节数 | 2 MiB |
| XLS/XLSB 表数 | 100 |
| 每表行/列绝对坐标范围（从 A1 起） | 10,000 / 256 |
| XLS/XLSB 全工作簿展开总格数（含空格） | 100,000 |
| 单元格文本 UTF-8 字节数 | 128 KiB |
| ZIP 所有条目实际累计解压量 | 64 MiB |
| ZIP 条目数 | 10,000 |

所有限制都失败关闭，不截断后宣称成功。ZIP 逐条目以 16 KiB 缓冲实际解压并验证 CRC，
包括未被引用的条目；声明大小只用于提前拒绝，不作为解压量证据。OLE 预检也拒绝 XOR FilePass。
打开文件前后复核 regular file，拒绝符号链接、FIFO、设备；Unix 使用 `O_NOFOLLOW | O_NONBLOCK`。

**仍需 Go/Linux 的进程级内存、CPU、墙钟时间、stdout 字节上限及并发限制。**
Calamine/anydoc/lopdf 可能在最终矩阵或 Markdown 限额验证前分配内存，尤其是 OLE 稀疏范围和 PDF
对象流；本 CLI 的输入/解压/输出限制不取代 `prlimit` 或隔离。建议运行环境禁用网络。

## 构建与测试

提交的 Cargo.lock 已锁定依赖；常规构建不可重生成它。所有缓存/target/测试临时文件放仓库外：

```sh
export CARGO_HOME="$PI_SCRATCH_DIR/document-converter-cargo"
export CARGO_TARGET_DIR="$PI_SCRATCH_DIR/document-converter-target"
export TMPDIR="$PI_SCRATCH_DIR/document-converter-target/tmp"
mkdir -p "$CARGO_HOME" "$TMPDIR"
cargo build --manifest-path apps/api/tools/document-converter/Cargo.toml --release --locked
cargo test --manifest-path apps/api/tools/document-converter/Cargo.toml --locked
cargo fmt --manifest-path apps/api/tools/document-converter/Cargo.toml --check
```

无本机 Rust 时，从仓库根目录使用固定镜像（Alpine 必须安装 `musl-dev`，否则 proc-macro 链接
会报 `cannot find crti.o`）：

```sh
docker run --rm --platform linux/arm64 \
  -v "$PWD/apps/api/tools/document-converter:/crate:ro" \
  -v "$PI_SCRATCH_DIR/document-converter-cargo:/cargo" \
  -v "$PI_SCRATCH_DIR/document-converter-target:/target" \
  -e CARGO_HOME=/cargo -e CARGO_TARGET_DIR=/target \
  -e TMPDIR=/target/tmp -e PI_SCRATCH_DIR=/target/tmp -w /crate \
  rust:1.88.0-alpine3.22@sha256:9dfaae478ecd298b6b5a039e1f2cc4fc040fc818a2de9aa78fa714dea036574d \
  sh -c 'apk add --no-cache musl-dev && mkdir -p /target/tmp && cargo build --release --locked && cargo test --locked'
```

仅在明确升级依赖时，以 Rust 1.88 设置
`CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback` 后运行 `cargo generate-lockfile`，
随后必须重新 `--locked` 编译验证。测试内存构造真实 CSV/RTF/DOCX、混合 PDF 拆页和 XLS/XLSB，
覆盖隐藏/空表、空列、缓存公式、损坏/加密、展开格数、单元格、ZIP 实际解压量和 UTF-8 输出上限，
CLI 测试还覆盖版本、退出码、单 JSON、脱敏、只读、regular file 和源大小。

## 许可证

本 crate 与自建测试夹具使用 MIT。发布时保留 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和
`licenses/`；其中保留 anydoc、Calamine 等原始版权及许可。Poppler 不由这个 crate 链接或执行，
其部署及 GPL 合规由上层处理。
