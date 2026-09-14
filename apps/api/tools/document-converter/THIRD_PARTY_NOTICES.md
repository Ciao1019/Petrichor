# 第三方许可证说明

本 crate 不修改或内嵌 anydoc/Calamine 源码，以 Cargo.lock 中的 crates.io 校验和锁定依赖。
发布二进制时须一并保留本目录的 LICENSE、THIRD_PARTY_NOTICES.md 和许可证附件。
测试夹具包含 Rust 测试代码构造的数据和 XLSB 兼容回归样例；它们仅用于测试，不进入运行镜像。

## 直接依赖

| 组件 | 固定版本 | 许可证 | 上游 |
| --- | --- | --- | --- |
| anydoc | 0.2.4 | MIT | https://github.com/firecrawl/anydoc |
| Calamine | 0.36.1 | MIT | https://github.com/tafia/calamine |
| pdf-inspector | 1.14.2 | MIT | https://github.com/firecrawl/pdf-inspector |
| lopdf | 0.42.0 | MIT | https://github.com/J-F-Liu/lopdf |
| zip | 8.6.0 | MIT | https://github.com/zip-rs/zip2 |
| cfb | 0.14.0 | MIT | https://github.com/mdsteele/rust-cfb |
| quick-xml | 0.41.0 | MIT | https://github.com/tafia/quick-xml |
| serde_json | 1.0.145 | MIT OR Apache-2.0（选择 MIT） | https://github.com/serde-rs/json |
| libc | 0.2.177 | MIT OR Apache-2.0（选择 MIT） | https://github.com/rust-lang/libc |

anydoc v0.2.4 对照的官方 Git 标签提交为
`42bf1c5ecdde9eb0d96d6bd75a9e6698cf93b14c`；实际构建从 crates.io 获取固定版本。

## MIT 版权声明（保留上游原文）

- anydoc: Copyright (c) 2026 Sideguide Technologies Inc.
- Calamine: Copyright (c) 2016 Johann Tuffe
- pdf-inspector: Copyright (c) 2026 Firecrawl
- lopdf: Copyright (c) 2016 Junfeng Liu
- zip: Copyright (c) 2014 Mathijs van de Nes
- cfb: Copyright (c) 2017 Matthew D. Steele
- quick-xml: Copyright (c) 2016 Johann Tuffe
- libc: Copyright (c) 2014-2020 The Rust Project Developers
- serde_json 的 LICENSE-MIT 没有单独版权行，保留其原许可条款。

以上 MIT 组件均适用以下许可（完整上游原件见许可证附件）：

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## 传递依赖与外部工具

许可证附件 `licenses/` 保留实际 Linux 构建依赖包根目录中的许可及 NOTICE 原文，
版本以文件名前缀和 Cargo.lock 为准。更新锁文件或切换目标平台时，应重新核对新引入依赖的许可。
Rust 标准库/工具链与基础系统的许可由构建/发布镜像继续保留；本目录不覆盖其许可义务。

本二进制不调用 Poppler、不执行 OCR、不调用任何联网服务。Go 层使用的 Poppler 是独立外部
组件，其 GPL 许可与源码提供义务由部署层另行处理，不属于本 crate 的 MIT 许可授权范围。
