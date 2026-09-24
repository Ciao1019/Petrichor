# Luo 落文

自托管字体，来自用户指定的 [Luo main 资源](https://cdn.jsdelivr.net/gh/tw93/Luo@main/dist/Luo-Regular.woff2)。

- 原始资源：[Luo-Regular.woff2](https://cdn.jsdelivr.net/gh/tw93/Luo@main/dist/Luo-Regular.woff2)
- 项目仓库：[tw93/Luo](https://github.com/tw93/Luo)
- 同版说明：[main README](https://cdn.jsdelivr.net/gh/tw93/Luo@main/README.md)
- 授权：SIL Open Font License 1.1；[main 授权原文](https://cdn.jsdelivr.net/gh/tw93/Luo@main/OFL.txt)保存在 [OFL.txt](./OFL.txt)。
- 获取日期：2026-09-22。
- 字体内部版本：`Version 0.4.11`，为获取时用户指定 jsDelivr `@main` URL 返回的资源。
- 文件大小：327,340 字节，约 320 KiB。
- SHA-256：`4b17fa4f2f344208ee4ae3a3aec787f7dcaf94c1b3f2f1605ed8ba822a90f130`。

字体文件未修改、未重新打包。原始授权注明部分字形来自 LXGW WenKai Screen。

## 字符覆盖与回退

此版本仍在造字中。main README 标注 GB2312 覆盖 1,115 / 6,763；文件 `cmap` 实际包含
1,129 个 Unicode 映射，其中 1,119 个位于 CJK 统一汉字区。常用文字中的
「询、签、搜、索、夜、模、链、晴」均需要回退，因此不能假设全部中文都由 Luo 渲染。

`src/styles/luo-font.css` 使用与官网一致的中文、中文标点及全角符号 Unicode 范围；
按用户的最新要求，中文保留 Luo，英文和数字恢复项目原有 Maple Mono：

```css
font-family: "Luo", "Maple Mono", Seravek, Candara, Optima,
             "Iowan Old Style", Charter, Georgia,
             "Avenir Next", "Noto Sans CJK SC", sans-serif;
```

Maple Mono 的正体、斜体资源沿用仓库原文件，由 `src/styles/maple-font.css` 声明；
英文和数字沿用原有的斜体继承，显式正体区域保持正体。
Luo 仅提供 `400 normal`，禁用字体合成使中文保持正体。缺失汉字由
`Noto Sans CJK SC` 或系统无衬线字体补足，未捆绑其他中文字体。
全局常规字重由 `src/styles/globals.css` 统一设置。
