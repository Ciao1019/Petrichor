import type { SiteProjectShowcaseRecord } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"

export const PROJECT_SHOWCASE_ID = 1

// 手绘马克笔圈词（stamp）的墨色，与「关于我」正文注记同源色板。
export type ProjectStampColor = "red" | "orange" | "green" | "teal" | "blue" | "purple" | "pink"

const STAMP_COLORS: readonly ProjectStampColor[] = ["red", "orange", "green", "teal", "blue", "purple", "pink"]

export interface ProjectItem {
    name: string
    year: string
    stack: string[]
    stamp: string
    stampColor: ProjectStampColor
    blurb: string
    repoUrl: string
    siteUrl: string
}

export const DEFAULT_PROJECT_SHOWCASE: {
    heading: string
    intro: string
    items: ProjectItem[]
} = {
    heading: "开源项目",
    intro: "",
    items: [
        {
            name: "Ech0 — self-hosted microblog",
            year: "2025",
            stack: ["Go", "Vue"],
            stamp: "popular",
            stampColor: "red",
            blurb: "An open-source, self-hosted space for publishing and sharing your thoughts — your own little corner of the web.",
            repoUrl: "https://github.com/lin-snow/Ech0",
            siteUrl: "https://ech0.app",
        },
        {
            name: "Dox — todos in terminal",
            year: "2026",
            stack: ["Go", "TypeScript"],
            stamp: "new",
            stampColor: "blue",
            blurb: "More than a todo list: a terminal-first task manager. TUI by default, CLI for scripts — projects, an inbox, markdown notes, full-text search and multi-user invites, all from one container and a single SQLite file.",
            repoUrl: "https://github.com/lin-snow/dox",
            siteUrl: "",
        },
        {
            name: "Kemate — a Vercel-like PaaS",
            year: "2026",
            stack: ["Go"],
            stamp: "WIP",
            stampColor: "green",
            blurb: "A platform-as-a-service taking aim at the likes of Vercel, built on a microservice architecture.",
            repoUrl: "",
            siteUrl: "",
        },
    ],
}

export interface ProjectShowcaseResponse {
    heading: string
    intro: string
    items: ProjectItem[]
    createdAt: string | null
    updatedAt: string | null
}

export interface ProjectShowcaseInput {
    heading: string
    intro: string
    items: ProjectItem[]
}

const textLimits = {
    heading: 100,
    intro: 300,
}

const itemLimits = {
    count: 40,
    name: 160,
    year: 20,
    stamp: 24,
    blurb: 800,
    url: 400,
    stackCount: 12,
    stackItem: 40,
}

export function buildProjectShowcaseResponse(record?: SiteProjectShowcaseRecord | null): ProjectShowcaseResponse {
    if (!record) {
        return {
            heading: DEFAULT_PROJECT_SHOWCASE.heading,
            intro: DEFAULT_PROJECT_SHOWCASE.intro,
            items: cloneItems(DEFAULT_PROJECT_SHOWCASE.items),
            createdAt: null,
            updatedAt: null,
        }
    }

    return {
        heading: safeText(record.heading, DEFAULT_PROJECT_SHOWCASE.heading),
        // intro 允许为空（用户可清空隐藏），故不走默认回退。
        intro: record.intro ?? DEFAULT_PROJECT_SHOWCASE.intro,
        items: parseItemsJson(record.itemsJson, DEFAULT_PROJECT_SHOWCASE.items),
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

export function validateProjectShowcaseInput(raw: unknown): ProjectShowcaseInput {
    const value = isRecord(raw) ? raw : {}

    return {
        heading: normalizeRequiredText(value.heading, DEFAULT_PROJECT_SHOWCASE.heading, "标题", textLimits.heading),
        intro: normalizeOptionalText(value.intro, textLimits.intro, "副标题"),
        items: normalizeItemsInput(value.items),
    }
}

export function serializeItems(values: ProjectItem[]) {
    return JSON.stringify(normalizeItems(values))
}

// 读取数据库 items JSON：缺失/损坏回退默认；合法但为空数组（用户主动清空）则尊重为空。
export function parseItemsJson(raw: string | null | undefined, fallback: readonly ProjectItem[]): ProjectItem[] {
    const text = raw?.trim()
    if (!text) {
        return cloneItems(fallback)
    }
    try {
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
            return cloneItems(fallback)
        }
        return normalizeItems(parsed)
    } catch {
        return cloneItems(fallback)
    }
}

function normalizeItemsInput(raw: unknown): ProjectItem[] {
    const source = Array.isArray(raw) ? raw : []
    const values = normalizeItems(source)
    if (values.length > itemLimits.count) {
        throw badRequest(`项目数量不能超过 ${itemLimits.count}`)
    }
    for (const item of values) {
        if (!item.name) {
            throw badRequest("项目名称不能为空")
        }
        if (item.name.length > itemLimits.name) {
            throw badRequest(`项目名称长度不能超过 ${itemLimits.name}`)
        }
        if (item.year.length > itemLimits.year) {
            throw badRequest(`项目年份长度不能超过 ${itemLimits.year}`)
        }
        if (item.stamp.length > itemLimits.stamp) {
            throw badRequest(`项目标签词长度不能超过 ${itemLimits.stamp}`)
        }
        if (item.blurb.length > itemLimits.blurb) {
            throw badRequest(`项目描述长度不能超过 ${itemLimits.blurb}`)
        }
        if (item.repoUrl.length > itemLimits.url || item.siteUrl.length > itemLimits.url) {
            throw badRequest(`项目链接长度不能超过 ${itemLimits.url}`)
        }
        if (item.stack.length > itemLimits.stackCount) {
            throw badRequest(`技术栈数量不能超过 ${itemLimits.stackCount}`)
        }
        for (const tech of item.stack) {
            if (tech.length > itemLimits.stackItem) {
                throw badRequest(`技术栈单项长度不能超过 ${itemLimits.stackItem}`)
            }
        }
    }
    return values
}

// 归一化项目数组：丢弃非对象/无名称项；各字段裁剪首尾空白，stampColor 非法时回退 red。
function normalizeItems(raw: readonly unknown[]): ProjectItem[] {
    const values: ProjectItem[] = []
    for (const entry of raw) {
        if (!isRecord(entry)) {
            continue
        }
        const name = oneLine(entry.name)
        if (!name) {
            continue
        }
        const colorRaw = String(entry.stampColor ?? "").trim()
        values.push({
            name,
            year: oneLine(entry.year),
            stack: normalizeStack(entry.stack),
            stamp: oneLine(entry.stamp),
            stampColor: isStampColor(colorRaw) ? colorRaw : "red",
            blurb: multiLine(entry.blurb),
            repoUrl: oneLine(entry.repoUrl),
            siteUrl: oneLine(entry.siteUrl),
        })
    }
    return values
}

function normalizeStack(raw: unknown): string[] {
    const source = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
            ? raw.split(/[,，\n]/)
            : []
    const seen = new Set<string>()
    const values: string[] = []
    for (const item of source) {
        const value = String(item ?? "").trim()
        if (!value || seen.has(value)) {
            continue
        }
        seen.add(value)
        values.push(value)
    }
    return values
}

function isStampColor(value: string): value is ProjectStampColor {
    return (STAMP_COLORS as readonly string[]).includes(value)
}

function cloneItems(values: readonly ProjectItem[]): ProjectItem[] {
    return values.map((item) => ({ ...item, stack: [...item.stack] }))
}

// 单行文本：折叠换行/首尾空白为一个空格。
function oneLine(raw: unknown): string {
    return String(raw ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .trim()
}

// 多行文本：保留段落换行，仅裁剪每行首尾空白。
function multiLine(raw: unknown): string {
    return String(raw ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .trim()
}

function normalizeOptionalText(raw: unknown, maxLength: number, label: string): string {
    const value = oneLine(raw)
    if (value.length > maxLength) {
        throw badRequest(`${label}长度不能超过 ${maxLength}`)
    }
    return value
}

function normalizeRequiredText(raw: unknown, fallback: string, label: string, maxLength: number) {
    const value = oneLine(raw) || fallback
    if (!value) {
        throw badRequest(`${label}不能为空`)
    }
    if (value.length > maxLength) {
        throw badRequest(`${label}长度不能超过 ${maxLength}`)
    }
    return value
}

function safeText(value: string | null | undefined, fallback: string) {
    const text = value?.trim()
    return text || fallback
}

function formatDate(value: Date | string | null | undefined) {
    if (!value) {
        return null
    }
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
