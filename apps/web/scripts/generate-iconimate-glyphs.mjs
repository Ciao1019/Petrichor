import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const args = process.argv.slice(2)
const sourceFlag = args.indexOf("--phosphor-source")

if (sourceFlag === -1 || !args[sourceFlag + 1]) {
  throw new Error("用法：node scripts/generate-iconimate-glyphs.mjs --phosphor-source <@phosphor-icons/core/package>")
}

const appRoot = resolve(import.meta.dirname, "..")
const sourceRoot = resolve(args[sourceFlag + 1])
const indexPath = resolve(appRoot, "src/components/iconimate/index.tsx")
const outputPath = resolve(appRoot, "src/components/iconimate/glyphs.generated.ts")
const indexSource = readFileSync(indexPath, "utf8")
const slugs = new Set()

for (const match of indexSource.matchAll(/icon\(\s*"[^"]+"\s*,\s*"([^"]+)"/g)) {
  slugs.add(match[1])
}

const glyphs = {}
const missing = []

for (const slug of [...slugs].sort()) {
  const svgPath = resolve(sourceRoot, `assets/regular/${slug}.svg`)

  if (!existsSync(svgPath)) {
    missing.push(slug)
    continue
  }

  const svg = readFileSync(svgPath, "utf8").trim()
  const content = svg.match(/^<svg\b[^>]*>([\s\S]*)<\/svg>$/)?.[1]

  if (!content) {
    throw new Error(`无法解析 ${svgPath}`)
  }

  glyphs[slug] = content
}

if (missing.length > 0) {
  throw new Error(`Phosphor 中不存在这些字形：${missing.join(", ")}`)
}

const output = `/**
 * 自动生成文件，请勿手改。
 * 字形来源：Phosphor Icons 2.1.1（MIT），与 Iconimate 使用的 256 网格一致。
 * 生成命令：node scripts/generate-iconimate-glyphs.mjs --phosphor-source <package-dir>
 */
export const GLYPHS = ${JSON.stringify(glyphs, null, 2)} as const
`

writeFileSync(outputPath, output)
console.log(`generated ${Object.keys(glyphs).length} glyphs -> ${outputPath}`)
