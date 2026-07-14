import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 倪海厦技能文件检索核心（纯逻辑，无 Mastra 依赖，便于单测）。
// 技能内容为渐进式披露的 markdown（SKILL.md 索引 + modules/ + cases/），
// vendored 在同目录 skill/ 下。Agent 通过 grep 定位行号、read 取原文作答。
// 内容来源：github.com/jangviktor-web/nihaixia（MulanPSL-2.0）。

const SKILL_SUBDIR = "src/server/assistant/nihaixia/skill"

/** 合法技能文件路径：根级白名单 + modules/cases/references 下的 .md。 */
const ALLOWED_FILE_PATTERN =
    /^(SKILL\.md|README\.md|distilled_cases\.md|expression_style\.md|modules\/[\w-]+\.md|cases\/[\w-]+\.md|references\/research\/[\w-]+\.md)$/

// 单次返回上限（中文约 1 字 ≈ 1 token，按字符封顶控制注入模型的体量）。
const GREP_MAX_MATCHES = 40
const GREP_SNIPPET_CHARS = 160
const READ_DEFAULT_LIMIT = 120
const READ_MAX_LIMIT = 400
const READ_MAX_CHARS = 6000

let resolvedBaseDir: string | null = null
const fileCache = new Map<string, string[]>()

function candidateBaseDirs(): string[] {
    const cwd = process.cwd()
    const candidates = [
        path.join(cwd, SKILL_SUBDIR),
        path.join(cwd, "apps/web", SKILL_SUBDIR),
    ]
    try {
        candidates.push(fileURLToPath(new URL("./skill", import.meta.url)))
    } catch {
        // import.meta.url 不可用时忽略
    }
    return candidates
}

/** 解析 vendored 技能目录；覆盖 dev(cwd=apps/web)、Vercel(cwd=函数根 + 文件 tracing)、monorepo 根。 */
export function resolveSkillBaseDir(): string {
    if (resolvedBaseDir) return resolvedBaseDir
    for (const dir of candidateBaseDirs()) {
        if (fs.existsSync(path.join(dir, "SKILL.md"))) {
            resolvedBaseDir = dir
            return dir
        }
    }
    throw new Error(
        `倪海厦技能文件未找到（已尝试 ${candidateBaseDirs().join(" / ")}）。请确认 ${SKILL_SUBDIR} 已随构建产物一并部署。`,
    )
}

export function isAllowedSkillFile(file: string): boolean {
    return ALLOWED_FILE_PATTERN.test(file)
}

function assertSafeFile(file: string): string {
    const normalized = file.trim().replace(/^\.\//, "")
    if (!isAllowedSkillFile(normalized)) {
        throw new Error(`不允许访问的技能文件：${file}`)
    }
    // 双保险：规范化后仍需落在技能目录内，杜绝路径穿越
    const base = resolveSkillBaseDir()
    const abs = path.resolve(base, normalized)
    const rel = path.relative(base, abs)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`不允许访问的技能文件：${file}`)
    }
    return normalized
}

function loadLines(file: string): string[] {
    const cached = fileCache.get(file)
    if (cached) return cached
    const abs = path.join(resolveSkillBaseDir(), file)
    const text = fs.readFileSync(abs, "utf8")
    const lines = text.split("\n")
    fileCache.set(file, lines)
    return lines
}

export type NihaixiaGrepMatch = { file: string; line: number; text: string }
export type NihaixiaGrepResult = {
    query: string
    matches: NihaixiaGrepMatch[]
    truncated: boolean
    searchedFiles: string[]
}

/**
 * 在技能文件里按关键词（子串，大小写不敏感）定位行号。
 * 不传 file → 只搜 SKILL.md（索引 + 六经核心）；传 file → 深搜指定模块。
 */
export function grepSkill(input: { query: string; file?: string | null }): NihaixiaGrepResult {
    const query = (input.query ?? "").trim()
    if (!query) {
        return { query, matches: [], truncated: false, searchedFiles: [] }
    }
    const targets = input.file ? [assertSafeFile(input.file)] : ["SKILL.md"]
    const needle = query.toLowerCase()
    const matches: NihaixiaGrepMatch[] = []
    let truncated = false

    for (const file of targets) {
        const lines = loadLines(file)
        for (let i = 0; i < lines.length; i += 1) {
            if (!lines[i]!.toLowerCase().includes(needle)) continue
            if (matches.length >= GREP_MAX_MATCHES) {
                truncated = true
                break
            }
            const raw = lines[i]!.trim()
            const text = raw.length > GREP_SNIPPET_CHARS ? `${raw.slice(0, GREP_SNIPPET_CHARS)}…` : raw
            matches.push({ file, line: i + 1, text })
        }
        if (truncated) break
    }

    return { query, matches, truncated, searchedFiles: targets }
}

export type NihaixiaReadResult = {
    file: string
    offset: number
    returnedLines: number
    totalLines: number
    hasMore: boolean
    content: string
}

/**
 * 读取技能文件的一段（1 起始行号）。返回带行号前缀的原文，按行数与字符数双重封顶。
 */
export function readSkill(input: { file: string; offset?: number | null; limit?: number | null }): NihaixiaReadResult {
    const file = assertSafeFile(input.file)
    const lines = loadLines(file)
    const totalLines = lines.length

    const rawOffset = Math.trunc(input.offset ?? 1)
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 1
    const rawLimit = Math.trunc(input.limit ?? READ_DEFAULT_LIMIT)
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : READ_DEFAULT_LIMIT, 1), READ_MAX_LIMIT)

    const start = offset - 1
    const out: string[] = []
    let chars = 0
    let consumed = 0
    for (let i = start; i < totalLines && consumed < limit; i += 1) {
        const numbered = `${i + 1}\t${lines[i]}`
        if (out.length > 0 && chars + numbered.length > READ_MAX_CHARS) break
        out.push(numbered)
        chars += numbered.length + 1
        consumed += 1
    }

    const lastLine = start + out.length
    return {
        file,
        offset,
        returnedLines: out.length,
        totalLines,
        hasMore: lastLine < totalLines,
        content: out.join("\n"),
    }
}

/** 供诊断/测试：列出实际 vendored 的技能文件（相对路径）。 */
export function listSkillFiles(): string[] {
    const base = resolveSkillBaseDir()
    const out: string[] = []
    const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name
            if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
            else if (entry.name.endsWith(".md")) out.push(rel)
        }
    }
    walk(base, "")
    return out.sort()
}

/** 测试辅助：清空进程内文件缓存与已解析目录。 */
export function __resetSkillFilesCacheForTests(): void {
    resolvedBaseDir = null
    fileCache.clear()
}
