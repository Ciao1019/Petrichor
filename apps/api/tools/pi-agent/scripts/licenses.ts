import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// 从未压缩 bundle 的模块来源提取实际包含的包，随镜像保留其许可证。
const bundle = await readFile("dist/index.js", "utf8");
const packages = [...new Set([...bundle.matchAll(/^\/\/ node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)].map(match => match[1]))].sort();
const piLicense = await readFile("THIRD_PARTY_NOTICES.md", "utf8");
const notices: string[] = [piLicense];
for (const name of packages) {
  if (name.startsWith("@earendil-works/")) continue;
  const root = join("node_modules", name);
  const files = (await readdir(root)).filter(file => /^licen[cs]e/i.test(file));
  if (files.length === 0) throw new Error(`缺少 ${name} 的许可证`);
  for (const file of files) notices.push(`\n## ${name}\n\n${await readFile(join(root, file), "utf8")}`);
}
await writeFile("dist/THIRD_PARTY_NOTICES.md", notices.join("\n"));
