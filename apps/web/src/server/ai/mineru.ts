import { inflateRawSync } from "node:zlib"
import { and, asc, eq } from "drizzle-orm"
import { getDb } from "@/server/db/client"
import { aiModelConfigs } from "@/server/db/schema"
import { decodeApiKey, MINERU_DEFAULT_BASE_URL } from "@/server/ai/config-logic"
import { badRequest } from "@/server/http/response"

export type MineruTaskState = "pending" | "running" | "converting" | "done" | "failed"

export interface MineruConfig {
    token: string
    baseUrl: string
}

export interface MineruTaskResult {
    state: MineruTaskState
    fullZipUrl: string | null
    totalPages: number | null
    extractedPages: number | null
    errMsg: string | null
}

export interface MineruParsedResult {
    markdown: string
    images: Array<{ ref: string; ext: string; bytes: Buffer }>
}

export interface MineruSubmitOptions {
    /** 是否强制 OCR（扫描件需要） */
    isOcr?: boolean
    enableFormula?: boolean
    enableTable?: boolean
    /** 文档主语言；不传则使用 MinerU 服务默认值 */
    language?: string
}

/**
 * 解析当前用户可用的 MinerU 配置：优先取默认且启用的 DOC_PARSE 配置，
 * 否则取任意一个启用的 DOC_PARSE 配置。
 */
export async function resolveMineruConfig(userId: number): Promise<MineruConfig> {
    const db = getDb()
    const [preferred] = await db
        .select()
        .from(aiModelConfigs)
        .where(and(
            eq(aiModelConfigs.userId, userId),
            eq(aiModelConfigs.configType, "DOC_PARSE"),
            eq(aiModelConfigs.isDefault, true),
            eq(aiModelConfigs.enabled, true),
        ))
        .orderBy(asc(aiModelConfigs.id))
        .limit(1)

    let config = preferred
    if (!config) {
        const [fallback] = await db
            .select()
            .from(aiModelConfigs)
            .where(and(
                eq(aiModelConfigs.userId, userId),
                eq(aiModelConfigs.configType, "DOC_PARSE"),
                eq(aiModelConfigs.enabled, true),
            ))
            .orderBy(asc(aiModelConfigs.id))
            .limit(1)
        config = fallback
    }

    if (!config) {
        throw badRequest("未找到可用的文档解析配置（请先在「模型配置 → 文档解析」中填入 MinerU Token 并启用）")
    }

    const token = decodeApiKey(config.apiKeyEnc)
    if (!token) {
        throw badRequest("文档解析配置缺少 MinerU Token")
    }
    const baseUrl = (config.baseUrl?.trim() || MINERU_DEFAULT_BASE_URL).replace(/\/+$/, "")
    return { token, baseUrl }
}

function authHeaders(token: string) {
    return {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
    }
}

async function readJsonSafe(response: Response): Promise<Record<string, unknown>> {
    try {
        return (await response.json()) as Record<string, unknown>
    } catch {
        return {}
    }
}

/** 提交一个按 URL 拉取文件的解析任务，返回 MinerU task_id。 */
export async function submitMineruTask(
    config: MineruConfig,
    fileUrl: string,
    options: MineruSubmitOptions = {},
): Promise<string> {
    const body: Record<string, unknown> = {
        url: fileUrl,
        is_ocr: options.isOcr ?? true,
        enable_formula: options.enableFormula ?? true,
        enable_table: options.enableTable ?? true,
    }
    if (options.language) {
        body.language = options.language
    }
    const response = await fetch(`${config.baseUrl}/api/v4/extract/task`, {
        method: "POST",
        headers: authHeaders(config.token),
        body: JSON.stringify(body),
    })
    const data = await readJsonSafe(response)
    const code = Number(data.code ?? -1)
    if (!response.ok || code !== 0) {
        const msg = typeof data.msg === "string" ? data.msg : `HTTP ${response.status}`
        throw badRequest(`提交 MinerU 解析任务失败：${msg}`)
    }
    const taskId = (data.data as { task_id?: unknown } | undefined)?.task_id
    if (typeof taskId !== "string" || !taskId) {
        throw badRequest("提交 MinerU 解析任务失败：未返回 task_id")
    }
    return taskId
}

/** 查询解析任务状态。 */
export async function queryMineruTask(config: MineruConfig, taskId: string): Promise<MineruTaskResult> {
    const response = await fetch(`${config.baseUrl}/api/v4/extract/task/${encodeURIComponent(taskId)}`, {
        method: "GET",
        headers: authHeaders(config.token),
    })
    const data = await readJsonSafe(response)
    const code = Number(data.code ?? -1)
    if (!response.ok || code !== 0) {
        const msg = typeof data.msg === "string" ? data.msg : `HTTP ${response.status}`
        throw badRequest(`查询 MinerU 解析任务失败：${msg}`)
    }
    const detail = (data.data ?? {}) as {
        state?: unknown
        full_zip_url?: unknown
        err_msg?: unknown
        extract_progress?: { extracted_pages?: unknown; total_pages?: unknown }
    }
    return {
        state: normalizeState(detail.state),
        fullZipUrl: typeof detail.full_zip_url === "string" ? detail.full_zip_url : null,
        totalPages: toIntOrNull(detail.extract_progress?.total_pages),
        extractedPages: toIntOrNull(detail.extract_progress?.extracted_pages),
        errMsg: typeof detail.err_msg === "string" && detail.err_msg ? detail.err_msg : null,
    }
}

/** 下载并解压 MinerU 结果 zip，取出 Markdown 与图片。 */
export async function fetchMineruResult(fullZipUrl: string): Promise<MineruParsedResult> {
    const response = await fetch(fullZipUrl)
    if (!response.ok) {
        throw badRequest(`下载 MinerU 解析结果失败：HTTP ${response.status}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const entries = unzip(buffer)

    const markdownEntry =
        entries.find((entry) => entry.name.toLowerCase().endsWith("full.md"))
        ?? entries.find((entry) => entry.name.toLowerCase().endsWith(".md"))
    if (!markdownEntry) {
        throw badRequest("MinerU 解析结果中未找到 Markdown 文件")
    }
    const markdown = markdownEntry.data.toString("utf8")
    const baseDir = markdownEntry.name.includes("/")
        ? markdownEntry.name.slice(0, markdownEntry.name.lastIndexOf("/") + 1)
        : ""

    const images = entries
        .filter((entry) => IMAGE_EXT_PATTERN.test(entry.name))
        .map((entry) => {
            // markdown 内通常以相对 markdown 文件的路径引用图片，去掉公共目录前缀
            const ref = baseDir && entry.name.startsWith(baseDir)
                ? entry.name.slice(baseDir.length)
                : entry.name
            const extMatch = entry.name.toLowerCase().match(/\.[a-z0-9]+$/)
            return { ref, ext: extMatch ? extMatch[0] : ".jpg", bytes: entry.data }
        })

    return { markdown, images }
}

const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

function normalizeState(raw: unknown): MineruTaskState {
    const value = String(raw ?? "").trim().toLowerCase()
    if (value === "done" || value === "running" || value === "converting" || value === "failed") {
        return value
    }
    return "pending"
}

function toIntOrNull(raw: unknown): number | null {
    const value = Number(raw)
    return Number.isFinite(value) ? Math.trunc(value) : null
}

// ---- 轻量 ZIP 解压（仅依赖 node:zlib，避免引入第三方依赖）----

interface ZipEntry {
    name: string
    data: Buffer
}

/**
 * 解析标准 ZIP（存储/Deflate）。基于中央目录读取条目，适配 MinerU 返回的结果包。
 * 不支持 ZIP64 与加密包（MinerU 结果包不会用到）。
 */
export function unzip(buffer: Buffer): ZipEntry[] {
    const eocd = findEndOfCentralDirectory(buffer)
    if (eocd < 0) {
        throw badRequest("MinerU 解析结果不是有效的 ZIP 文件")
    }
    const entryCount = buffer.readUInt16LE(eocd + 10)
    let offset = buffer.readUInt32LE(eocd + 16)
    const entries: ZipEntry[] = []

    for (let i = 0; i < entryCount; i++) {
        if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
            break
        }
        const method = buffer.readUInt16LE(offset + 10)
        const compressedSize = buffer.readUInt32LE(offset + 20)
        const nameLen = buffer.readUInt16LE(offset + 28)
        const extraLen = buffer.readUInt16LE(offset + 30)
        const commentLen = buffer.readUInt16LE(offset + 32)
        const localOffset = buffer.readUInt32LE(offset + 42)
        const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen)

        const localNameLen = buffer.readUInt16LE(localOffset + 26)
        const localExtraLen = buffer.readUInt16LE(localOffset + 28)
        const dataStart = localOffset + 30 + localNameLen + localExtraLen
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize)

        if (!name.endsWith("/")) {
            let data: Buffer
            if (method === 0) {
                data = Buffer.from(compressed)
            } else if (method === 8) {
                data = inflateRawSync(compressed)
            } else {
                throw badRequest(`MinerU 结果包含不支持的压缩方式：${method}`)
            }
            entries.push({ name, data })
        }

        offset += 46 + nameLen + extraLen + commentLen
    }

    return entries
}

function findEndOfCentralDirectory(buffer: Buffer): number {
    const minOffset = Math.max(0, buffer.length - (22 + 0xffff))
    for (let i = buffer.length - 22; i >= minOffset; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            return i
        }
    }
    return -1
}
