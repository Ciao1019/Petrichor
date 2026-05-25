import type { SiteAboutProfileRecord } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"

export const ABOUT_PROFILE_ID = 1

export const DEFAULT_ABOUT_PROFILE = {
    displayName: "CiZai",
    roleTitle: "Creative Dev & Visual Artist",
    intro: "我是 CiZai，是一个普普通通的程序员。\n\n目前就职于金山办公\n\n我的兴趣主要在 Coding / AI 方向。\n\n我喜欢 Minecraft。",
    expertise: ["Frontend Architecture", "AI 应用开发", "Knowledge Systems", "Creative Coding"],
    toolkit: ["TypeScript", "React", "Next.js", "AI", "PostgreSQL", "Minecraft"],
    quote: "Code is just another medium for painting dreams.",
} as const

export interface AboutProfileResponse {
    displayName: string
    roleTitle: string
    intro: string
    expertise: string[]
    toolkit: string[]
    quote: string
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
}

const textLimits = {
    displayName: 100,
    roleTitle: 160,
    intro: 4000,
    quote: 500,
    listItem: 100,
    listCount: 20,
}

export function buildAboutProfileResponse(record?: SiteAboutProfileRecord | null): AboutProfileResponse {
    if (!record) {
        return {
            ...DEFAULT_ABOUT_PROFILE,
            expertise: [...DEFAULT_ABOUT_PROFILE.expertise],
            toolkit: [...DEFAULT_ABOUT_PROFILE.toolkit],
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
    }
}

export function serializeProfileList(values: string[]) {
    return JSON.stringify(normalizeListForRead(values, []))
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
