import type { SiteAboutProfileRecord } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"

export const ABOUT_PROFILE_ID = 1

// 正文注记样式：red/orange/green/teal/blue/purple/pink 为手绘波浪下划线，yellow 为荧光笔高亮。
export type AboutAccentStyle = "red" | "orange" | "green" | "teal" | "blue" | "purple" | "pink" | "yellow"

const ACCENT_STYLES: readonly AboutAccentStyle[] = ["red", "orange", "green", "teal", "blue", "purple", "pink", "yellow"]

export interface AboutAccent {
    phrase: string
    style: AboutAccentStyle
    note?: string
}

export const DEFAULT_ABOUT_PROFILE = {
    displayName: "CiZai",
    roleTitle: "Creative Dev & Visual Artist",
    intro: "我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。",
    expertise: ["Frontend Architecture", "AI 应用开发", "Knowledge Systems", "Creative Coding"],
    toolkit: ["TypeScript", "React", "Bun", "Vite", "AI", "PostgreSQL", "Minecraft"],
    quote: "Code is just another medium for painting dreams.",
    accents: [
        { phrase: "CiZai", style: "red", note: "yep, that's me" },
        { phrase: "程序员", style: "green", note: "just a dev" },
        { phrase: "金山办公", style: "blue", note: "where I work" },
        { phrase: "Coding / AI", style: "green", note: "my playground" },
        { phrase: "Minecraft", style: "blue", note: "★ my comfort game" },
    ],
    contactText: "想聊点什么？随时",
    contactLabel: "message me",
    contactHref: "mailto:zang@linux.do",
} as const

export interface AboutProfileResponse {
    displayName: string
    roleTitle: string
    intro: string
    expertise: string[]
    toolkit: string[]
    quote: string
    accents: AboutAccent[]
    contactText: string
    contactLabel: string
    contactHref: string
    createdAt: string | null
    updatedAt: string | null
}

export interface AboutProfileInput {
    displayName: string
    roleTitle: string
    intro: string
    expertise: string[]
    toolkit: string[]
    quote: string
    accents: AboutAccent[]
    contactText: string
    contactLabel: string
    contactHref: string
}

const textLimits = {
    displayName: 100,
    roleTitle: 160,
    intro: 4000,
    quote: 500,
    listItem: 100,
    listCount: 20,
    contactText: 200,
    contactLabel: 80,
    contactHref: 400,
}

const accentLimits = {
    count: 24,
    phrase: 100,
    note: 100,
}

export function buildAboutProfileResponse(record?: SiteAboutProfileRecord | null): AboutProfileResponse {
    if (!record) {
        return {
            ...DEFAULT_ABOUT_PROFILE,
            expertise: [...DEFAULT_ABOUT_PROFILE.expertise],
            toolkit: [...DEFAULT_ABOUT_PROFILE.toolkit],
            accents: cloneAccents(DEFAULT_ABOUT_PROFILE.accents),
            createdAt: null,
            updatedAt: null,
        }
    }

    return {
        displayName: safeText(record.displayName, DEFAULT_ABOUT_PROFILE.displayName),
        roleTitle: safeText(record.roleTitle, DEFAULT_ABOUT_PROFILE.roleTitle),
        intro: safeText(record.intro, DEFAULT_ABOUT_PROFILE.intro),
        expertise: parseProfileListJson(record.expertiseJson, DEFAULT_ABOUT_PROFILE.expertise),
        toolkit: parseProfileListJson(record.toolkitJson, DEFAULT_ABOUT_PROFILE.toolkit),
        quote: safeText(record.quote, DEFAULT_ABOUT_PROFILE.quote),
        accents: parseAccentsJson(record.accentsJson, DEFAULT_ABOUT_PROFILE.accents),
        // 联系方式三项允许为空（用户可清空以隐藏），故不走 safeText 回退默认。
        contactText: record.contactText ?? DEFAULT_ABOUT_PROFILE.contactText,
        contactLabel: record.contactLabel ?? DEFAULT_ABOUT_PROFILE.contactLabel,
        contactHref: record.contactHref ?? DEFAULT_ABOUT_PROFILE.contactHref,
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

export function validateAboutProfileInput(raw: unknown): AboutProfileInput {
    const value = isRecord(raw) ? raw : {}

    return {
        displayName: normalizeRequiredText(value.displayName, DEFAULT_ABOUT_PROFILE.displayName, "名称", textLimits.displayName),
        roleTitle: normalizeRequiredText(value.roleTitle, DEFAULT_ABOUT_PROFILE.roleTitle, "副标题", textLimits.roleTitle),
        intro: normalizeRequiredText(value.intro, DEFAULT_ABOUT_PROFILE.intro, "自我介绍", textLimits.intro),
        expertise: normalizeRequiredList(value.expertise, DEFAULT_ABOUT_PROFILE.expertise, "Expertise"),
        toolkit: normalizeRequiredList(value.toolkit, DEFAULT_ABOUT_PROFILE.toolkit, "Toolkit"),
        quote: normalizeRequiredText(value.quote, DEFAULT_ABOUT_PROFILE.quote, "quote", textLimits.quote),
        accents: normalizeAccentsInput(value.accents),
        contactText: normalizeOptionalText(value.contactText, textLimits.contactText, "联系引导语"),
        contactLabel: normalizeOptionalText(value.contactLabel, textLimits.contactLabel, "联系链接文字"),
        contactHref: normalizeOptionalText(value.contactHref, textLimits.contactHref, "联系链接地址"),
    }
}

export function serializeProfileList(values: string[]) {
    return JSON.stringify(normalizeListForRead(values, []))
}

export function serializeAccents(values: AboutAccent[]) {
    return JSON.stringify(normalizeAccents(values))
}

// 读取数据库 accents JSON：缺失/损坏回退默认；合法但为空数组（用户主动清空）则尊重为空。
export function parseAccentsJson(raw: string | null | undefined, fallback: readonly AboutAccent[]): AboutAccent[] {
    const text = raw?.trim()
    if (!text) {
        return cloneAccents(fallback)
    }
    try {
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
            return cloneAccents(fallback)
        }
        return normalizeAccents(parsed)
    } catch {
        return cloneAccents(fallback)
    }
}

function normalizeAccentsInput(raw: unknown): AboutAccent[] {
    const source = Array.isArray(raw) ? raw : []
    const values = normalizeAccents(source)
    if (values.length > accentLimits.count) {
        throw badRequest(`正文注记数量不能超过 ${accentLimits.count}`)
    }
    for (const accent of values) {
        if (accent.phrase.length > accentLimits.phrase) {
            throw badRequest(`正文注记短语长度不能超过 ${accentLimits.phrase}`)
        }
        if (accent.note && accent.note.length > accentLimits.note) {
            throw badRequest(`正文注记气泡文案长度不能超过 ${accentLimits.note}`)
        }
    }
    return values
}

// 归一化注记数组：丢弃非对象/空短语项，按短语去重，style 非法时回退 red，note 为空则省略。
function normalizeAccents(raw: readonly unknown[]): AboutAccent[] {
    const seen = new Set<string>()
    const values: AboutAccent[] = []
    for (const item of raw) {
        if (!isRecord(item)) {
            continue
        }
        const phrase = String(item.phrase ?? "").trim()
        if (!phrase || seen.has(phrase)) {
            continue
        }
        const styleRaw = String(item.style ?? "").trim()
        const style: AboutAccentStyle = isAccentStyle(styleRaw) ? styleRaw : "red"
        const note = String(item.note ?? "").trim()
        seen.add(phrase)
        values.push(note ? { phrase, style, note } : { phrase, style })
    }
    return values
}

function isAccentStyle(value: string): value is AboutAccentStyle {
    return (ACCENT_STYLES as readonly string[]).includes(value)
}

function cloneAccents(values: readonly AboutAccent[]): AboutAccent[] {
    return values.map((accent) =>
        accent.note
            ? { phrase: accent.phrase, style: accent.style, note: accent.note }
            : { phrase: accent.phrase, style: accent.style },
    )
}

// 可选单行文本：折叠换行/首尾空白；允许为空字符串（用于可清空的联系方式三项）。
function normalizeOptionalText(raw: unknown, maxLength: number, label: string): string {
    const value = String(raw ?? "")
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .trim()
    if (value.length > maxLength) {
        throw badRequest(`${label}长度不能超过 ${maxLength}`)
    }
    return value
}

export function parseProfileListJson(raw: string | null | undefined, fallback: readonly string[]) {
    const text = raw?.trim()
    if (!text) {
        return [...fallback]
    }

    try {
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
            return [...fallback]
        }
        const values = normalizeListForRead(parsed, fallback)
        return values.length > 0 ? values : [...fallback]
    } catch {
        return [...fallback]
    }
}

function normalizeRequiredText(raw: unknown, fallback: string, label: string, maxLength: number) {
    const value = String(raw ?? fallback)
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .trim()
    if (!value) {
        throw badRequest(`${label}不能为空`)
    }
    if (value.length > maxLength) {
        throw badRequest(`${label}长度不能超过 ${maxLength}`)
    }
    return value
}

function normalizeRequiredList(raw: unknown, fallback: readonly string[], label: string) {
    const source = raw == null
        ? [...fallback]
        : Array.isArray(raw)
            ? raw
            : String(raw).split(/\r?\n/)
    const values = normalizeListForRead(source, [])

    if (values.length === 0) {
        throw badRequest(`${label} 不能为空`)
    }
    if (values.length > textLimits.listCount) {
        throw badRequest(`${label} 数量不能超过 ${textLimits.listCount}`)
    }

    for (const item of values) {
        if (item.length > textLimits.listItem) {
            throw badRequest(`${label} 单项长度不能超过 ${textLimits.listItem}`)
        }
    }

    return values
}

function normalizeListForRead(raw: readonly unknown[], fallback: readonly string[]) {
    const seen = new Set<string>()
    const values: string[] = []

    for (const item of raw) {
        const value = String(item ?? "").trim()
        if (!value || seen.has(value)) {
            continue
        }
        seen.add(value)
        values.push(value)
    }

    return values.length > 0 ? values : [...fallback]
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
