import path from "node:path"

const distDirectory = path.resolve(import.meta.dir, "../dist")
const initialTransferBudget = 350 * 1024
const chunkTransferBudget = 600 * 1024

const indexHtml = await Bun.file(path.join(distDirectory, "index.html")).text()
const initialAssets = [...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g)]
  .flatMap((match) => match[1] ? [match[1]] : [])
const initialBytes = await sumPreferredTransferBytes(initialAssets)
if (initialBytes > initialTransferBudget) {
  throw new Error(`首屏 JS/CSS Brotli 体积 ${formatBytes(initialBytes)} 超过预算 ${formatBytes(initialTransferBudget)}`)
}

const assetDirectory = path.join(distDirectory, "assets")
const assetNames = await Array.fromAsync(new Bun.Glob("**/*.js").scan({ cwd: assetDirectory }))
let largest = { name: "", bytes: 0 }
for (const name of assetNames) {
  const source = Bun.file(path.join(assetDirectory, name))
  if (source.size >= 1024) {
    for (const suffix of [".br", ".gz"]) {
      if (!await Bun.file(`${source.name}${suffix}`).exists()) {
        throw new Error(`缺少预压缩资源：${name}${suffix}`)
      }
    }
  }
  const compressed = Bun.file(`${source.name}.br`)
  const bytes = await compressed.exists() ? compressed.size : source.size
  if (bytes > largest.bytes) largest = { name, bytes }
}
if (largest.bytes > chunkTransferBudget) {
  throw new Error(`最大 JS chunk ${largest.name} 为 ${formatBytes(largest.bytes)}，超过预算 ${formatBytes(chunkTransferBudget)}`)
}

const optimizedAvatar = Bun.file(path.join(distDirectory, "about-avatar.avif"))
if (!await optimizedAvatar.exists() || optimizedAvatar.size > 64 * 1024) {
  throw new Error("about-avatar.avif 缺失或超过 64 KiB")
}

console.log(`包体预算通过：首屏 ${formatBytes(initialBytes)}；最大 chunk ${largest.name} ${formatBytes(largest.bytes)}`)

async function sumPreferredTransferBytes(urls: string[]) {
  let total = 0
  for (const url of new Set(urls)) {
    const sourcePath = path.join(distDirectory, url.replace(/^\//, ""))
    const brotli = Bun.file(`${sourcePath}.br`)
    total += await brotli.exists() ? brotli.size : Bun.file(sourcePath).size
  }
  return total
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}
