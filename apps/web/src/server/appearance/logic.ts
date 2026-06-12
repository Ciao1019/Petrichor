import type { SiteAppearanceRecord } from "@/server/db/schema"
import {
    DEFAULT_RETYPESET_APPEARANCE,
    type RetypesetAppearanceConfig,
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
        publicQaEnabled: record.publicQaEnabled ?? DEFAULT_RETYPESET_APPEARANCE.publicQaEnabled,
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

export function validateSiteAppearanceInput(raw: unknown): RetypesetAppearanceConfig {
    const value = isRecord(raw) ? raw : {}
    const publicQaEnabled =
        typeof value.publicQaEnabled === "boolean"
            ? value.publicQaEnabled
            : DEFAULT_RETYPESET_APPEARANCE.publicQaEnabled

    return { publicQaEnabled }
}

function formatDate(value: Date | string | null | undefined) {
    if (!value) return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
