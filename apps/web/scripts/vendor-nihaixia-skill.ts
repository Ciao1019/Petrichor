import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 重新 vendor 倪海厦技能内容（github.com/jangviktor-web/nihaixia，MulanPSL-2.0）。
// 倪海厦选项走「打包进仓库」路线：朋友更新上游仓库后，跑本脚本一键重同步。
//   pnpm --filter @petrichor/web vendor:nihaixia
// 会拉取上游全部 .md（含未来新增文件）覆盖 src/server/assistant/nihaixia/skill/。
// 策略：先全部下载到同目录暂存文件夹，成功后再原子替换 —— 中途网络失败不会破坏已 vendor 的内容。

const REPO = "jangviktor-web/nihaixia"
const REF = process.env.NIHAIXIA_REF?.trim() || "HEAD"
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${REF}`
const TREE_API = `https://api.github.com/repos/${REPO}/git/trees/${REF}?recursive=1`

const destRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)), "src/server/assistant/nihaixia/skill")
// 暂存目录与目标同父目录 → 同一文件系统，rename 可原子替换
const staging = `${destRoot}.staging-${Date.now()}`

type TreeEntry = { path: string; type: string }

async function fetchTextWithRetry(url: string, tries = 5): Promise<string> {
    let lastError: unknown
    for (let attempt = 1; attempt <= tries; attempt += 1) {
        try {
            const res = await fetch(url, { headers: { "User-Agent": "petrichor-vendor-script" } })
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
            return await res.text()
        } catch (error) {
            lastError = error
            if (attempt < tries) await new Promise((r) => setTimeout(r, attempt * 1500))
        }
    }
    throw new Error(`拉取失败（${tries} 次重试后）${url}：${String(lastError)}`)
}

async function main() {
    const tree = JSON.parse(await fetchTextWithRetry(TREE_API)) as { tree?: TreeEntry[]; message?: string }
    if (!tree.tree) throw new Error(`仓库树响应异常：${tree.message ?? "unknown"}`)

    const mdFiles = tree.tree.filter((t) => t.type === "blob" && t.path.endsWith(".md")).map((t) => t.path)
    if (mdFiles.length === 0) throw new Error("上游未发现任何 .md 文件，已中止（避免误清空）")

    // 1) 下载到同目录暂存文件夹
    fs.rmSync(staging, { recursive: true, force: true })
    let bytes = 0
    for (const rel of mdFiles) {
        const text = await fetchTextWithRetry(`${RAW_BASE}/${rel}`)
        if (!text) throw new Error(`下载到空内容：${rel}`)
        const abs = path.join(staging, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, text, "utf8")
        bytes += Buffer.byteLength(text, "utf8")
    }

    // 2) 全部成功后再原子替换
    fs.rmSync(destRoot, { recursive: true, force: true })
    fs.renameSync(staging, destRoot)

    console.log(
        `✓ 已 vendor ${mdFiles.length} 个文件（${(bytes / 1024 / 1024).toFixed(2)} MB @ ${REPO}#${REF}）到 ${path.relative(process.cwd(), destRoot)}`,
    )
}

main().catch((error) => {
    // 暂存目录清掉，绝不动已 vendor 的目标目录
    fs.rmSync(staging, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
})
