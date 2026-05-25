import type { SiteAppearanceRecord } from "@/server/db/schema"
import { badRequest } from "@/server/http/response"
import {
    DEFAULT_RETYPESET_APPEARANCE,
    isRetypesetThemeId,
    type RetypesetAppearanceConfig,
    type RetypesetThemeId,
} from "@/lib/retypeset-themes"

export const SITE_APPEARANCE_ID = 1

export interface SiteAppearanceResponse extends RetypesetAppearanceConfig {
    createdAt: string | null
    updatedAt: string | null
}

export function buildSiteAppearanceResponse(record?: SiteAppearanceRecord | null): SiteAppearanceResponse {
    if (!record) {
        return {
            ...DEFAULT_RETYPESET_APPEARANCE,
            createdAt: null,
            updatedAt: null,
        }
    }
    return {
        dayTheme: isRetypesetThemeId(record.dayTheme) ? record.dayTheme : DEFAULT_RETYPESET_APPEARANCE.dayTheme,
        nightTheme: isRetypesetThemeId(record.nightTheme)
            ? record.nightTheme
            : DEFAULT_RETYPESET_APPEARANCE.nightTheme,
        dayStartHour: clampHour(record.dayStartHour, DEFAULT_RETYPESET_APPEARANCE.dayStartHour),
        dayEndHour: clampHour(record.dayEndHour, DEFAULT_RETYPESET_APPEARANCE.dayEndHour),
        allowManualOverride: Boolean(record.allowManualOverride),
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

export function validateSiteAppearanceInput(raw: unknown): RetypesetAppearanceConfig {
    const value = isRecord(raw) ? raw : {}
    const dayTheme = normalizeThemeId(value.dayTheme, "白天主题")
    const nightTheme = normalizeThemeId(value.nightTheme, "夜间主题")
    const dayStartHour = normalizeHour(value.dayStartHour, "白天开始时间")
    const dayEndHour = normalizeHour(value.dayEndHour, "白天结束时间")
    const allowManualOverride =
        typeof value.allowManualOverride === "boolean"
            ? value.allowManualOverride
            : DEFAULT_RETYPESET_APPEARANCE.allowManualOverride

    if (dayStartHour === dayEndHour) {
        throw badRequest("白天开始时间不能与结束时间相同")
    }

    return { dayTheme, nightTheme, dayStartHour, dayEndHour, allowManualOverride }
}

function normalizeThemeId(raw: unknown, label: string): RetypesetThemeId {
    if (typeof raw !== "string") {
        throw badRequest(`${label}不能为空`)
    }
    const trimmed = raw.trim()
    if (!isRetypesetThemeId(trimmed)) {
        throw badRequest(`${label}非法`)
    }
    return trimmed
}

function normalizeHour(raw: unknown, label: string): number {
    const n = typeof raw === "number" ? raw : Number(raw)
    if (!Number.isFinite(n)) {
        throw badRequest(`${label}必须是 0–24 的整数`)
    }
    const int = Math.trunc(n)
    if (int < 0 || int > 24) {
        throw badRequest(`${label}必须在 0–24 之间`)
    }
    return int
}

function clampHour(value: number, fallback: number) {
    if (!Number.isFinite(value)) return fallback
    const int = Math.trunc(value)
    if (int < 0) return 0
    if (int > 24) return 24
    return int
}

function formatDate(value: Date | string | null | undefined) {
    if (!value) return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
