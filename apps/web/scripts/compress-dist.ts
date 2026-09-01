import { readdir } from "node:fs/promises"
import path from "node:path"
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib"

const distDirectory = path.resolve(import.meta.dir, "../dist")
const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".xml",
])
const minimumBytes = 1024

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? collectFiles(target) : [target]
  }))
  return nested.flat()
}

const files = (await collectFiles(distDirectory)).filter((file) => {
  return compressibleExtensions.has(path.extname(file))
})

let compressedFiles = 0
let sourceBytes = 0
let brotliBytes = 0
for (const file of files) {
  const source = Buffer.from(await Bun.file(file).arrayBuffer())
  if (source.byteLength < minimumBytes) continue

  const brotli = brotliCompressSync(source, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: path.extname(file) === ".wasm"
        ? zlibConstants.BROTLI_MODE_GENERIC
        : zlibConstants.BROTLI_MODE_TEXT,
    },
  })
  const gzip = gzipSync(source, { level: 9 })
  await Promise.all([
    Bun.write(`${file}.br`, brotli),
    Bun.write(`${file}.gz`, gzip),
  ])
  compressedFiles += 1
  sourceBytes += source.byteLength
  brotliBytes += brotli.byteLength
}

const saving = sourceBytes === 0 ? 0 : Math.round((1 - brotliBytes / sourceBytes) * 100)
console.log(`预压缩 ${compressedFiles} 个静态资源，Brotli 平均节省 ${saving}%`)
