export type RetypesetThemeId =
    | "paper"
    | "slate"
    | "sakura"
    | "matcha"
    | "ink"
    | "ocean"
    | "forest"
    | "sand"

export type RetypesetThemeTone = "light" | "dark"

export const RETYPESET_THEME_STORAGE_KEY = "retypeset:theme-override"
export const RETYPESET_THEME_STORAGE_AUTO = "auto"
export const RETYPESET_THEME_ATTR = "data-retypeset-theme"
export const RETYPESET_INITIAL_APPEARANCE_GLOBAL = "__RETYPESET_INITIAL_APPEARANCE__"

export interface RetypesetThemeDefinition {
    id: RetypesetThemeId
    label: string
    tone: RetypesetThemeTone
    /** 标题/强调色 */
    primary: string
    /** 正文色 */
    secondary: string
    /** 页面背景色 */
    background: string
    /** 反相表面（如卡片浮层）基色，用于派生 surface/border */
    surfaceTint: string
    /** 选中/链接荧光高亮 */
    highlight: string
    /** 强调互动色（hover/focus） */
    accent: string
}

export const RETYPESET_THEMES: Record<RetypesetThemeId, RetypesetThemeDefinition> = {
    paper: {
        id: "paper",
        label: "Paper 米白",
        tone: "light",
        primary: "oklch(25% 0.012 80)",
        secondary: "oklch(38% 0.012 80)",
        background: "oklch(96% 0.012 85)",
        surfaceTint: "oklch(20% 0.012 80)",
        highlight: "oklch(0.93 0.195 103 / 0.45)",
        accent: "oklch(58% 0.16 50)",
    },
    slate: {
        id: "slate",
        label: "Slate 深炭",
        tone: "dark",
        primary: "oklch(94% 0.005 260)",
        secondary: "oklch(80% 0.008 260)",
        background: "oklch(20% 0.005 260)",
        surfaceTint: "oklch(95% 0.005 260)",
        highlight: "oklch(0.93 0.195 103 / 0.32)",
        accent: "oklch(82% 0.16 84)",
    },
    sakura: {
        id: "sakura",
        label: "Sakura 樱粉",
        tone: "light",
        primary: "oklch(30% 0.06 0)",
        secondary: "oklch(42% 0.05 5)",
        background: "oklch(96% 0.018 10)",
        surfaceTint: "oklch(28% 0.08 5)",
        highlight: "oklch(0.82 0.18 0 / 0.4)",
        accent: "oklch(60% 0.18 5)",
    },
    matcha: {
        id: "matcha",
        label: "Matcha 抹茶",
        tone: "light",
        primary: "oklch(28% 0.04 150)",
        secondary: "oklch(38% 0.045 150)",
        background: "oklch(94% 0.025 140)",
        surfaceTint: "oklch(26% 0.06 150)",
        highlight: "oklch(0.82 0.15 130 / 0.4)",
        accent: "oklch(52% 0.14 145)",
    },
    ink: {
        id: "ink",
        label: "Ink 墨纸",
        tone: "light",
        primary: "oklch(18% 0.008 60)",
        secondary: "oklch(32% 0.012 60)",
        background: "oklch(93% 0.018 80)",
        surfaceTint: "oklch(18% 0.008 60)",
        highlight: "oklch(0.66 0.21 28 / 0.35)",
        accent: "oklch(50% 0.18 28)",
    },
    ocean: {
        id: "ocean",
        label: "Ocean 海蓝",
        tone: "light",
        primary: "oklch(28% 0.07 235)",
        secondary: "oklch(40% 0.06 235)",
        background: "oklch(95% 0.025 220)",
        surfaceTint: "oklch(24% 0.08 235)",
        highlight: "oklch(0.86 0.16 195 / 0.45)",
        accent: "oklch(58% 0.16 220)",
    },
    forest: {
        id: "forest",
        label: "Forest 深林",
        tone: "dark",
        primary: "oklch(92% 0.02 140)",
        secondary: "oklch(78% 0.025 140)",
        background: "oklch(22% 0.025 150)",
        surfaceTint: "oklch(95% 0.02 140)",
        highlight: "oklch(0.84 0.16 130 / 0.32)",
        accent: "oklch(80% 0.15 120)",
    },
    sand: {
        id: "sand",
        label: "Sand 沙黄",
        tone: "light",
        primary: "oklch(26% 0.04 70)",
        secondary: "oklch(38% 0.045 70)",
        background: "oklch(94% 0.045 85)",
        surfaceTint: "oklch(22% 0.05 70)",
        highlight: "oklch(0.86 0.16 80 / 0.45)",
        accent: "oklch(58% 0.15 60)",
    },
}

export const RETYPESET_THEME_IDS = Object.keys(RETYPESET_THEMES) as RetypesetThemeId[]

export function isRetypesetThemeId(value: unknown): value is RetypesetThemeId {
    return typeof value === "string" && value in RETYPESET_THEMES
}

export function getRetypesetTheme(id: RetypesetThemeId): RetypesetThemeDefinition {
    return RETYPESET_THEMES[id]
}

export interface RetypesetAppearanceConfig {
    dayTheme: RetypesetThemeId
    nightTheme: RetypesetThemeId
    /** 0–23 整点，白天起 */
    dayStartHour: number
    /** 0–23 整点，白天止（不含），24 表示永远是白天 */
    dayEndHour: number
    /** 是否允许访客手动切换并记忆 */
    allowManualOverride: boolean
}

export type RetypesetAppearanceInput = Partial<Record<keyof RetypesetAppearanceConfig, unknown>>

export const DEFAULT_RETYPESET_APPEARANCE: RetypesetAppearanceConfig = {
    dayTheme: "paper",
    nightTheme: "slate",
    dayStartHour: 6,
    dayEndHour: 18,
    allowManualOverride: true,
}

export function pickThemeByHour(
    config: RetypesetAppearanceConfig,
    hour: number,
): RetypesetThemeId {
    const { dayStartHour, dayEndHour, dayTheme, nightTheme } = config
    if (dayStartHour === dayEndHour) return dayTheme
    if (dayStartHour < dayEndHour) {
        return hour >= dayStartHour && hour < dayEndHour ? dayTheme : nightTheme
    }
    return hour >= dayStartHour || hour < dayEndHour ? dayTheme : nightTheme
}

export function resolveRetypesetActiveTheme(
    config: RetypesetAppearanceConfig,
    hour: number,
    override?: unknown,
): RetypesetThemeId {
    if (config.allowManualOverride && isRetypesetThemeId(override)) {
        return override
    }
    return pickThemeByHour(config, hour)
}

export function normalizeAppearance(
    raw: RetypesetAppearanceInput | null | undefined,
): RetypesetAppearanceConfig {
    const source = raw ?? {}
    const dayTheme = isRetypesetThemeId(source.dayTheme)
        ? source.dayTheme
        : DEFAULT_RETYPESET_APPEARANCE.dayTheme
    const nightTheme = isRetypesetThemeId(source.nightTheme)
        ? source.nightTheme
        : DEFAULT_RETYPESET_APPEARANCE.nightTheme
    const dayStartHour = clampHour(source.dayStartHour, DEFAULT_RETYPESET_APPEARANCE.dayStartHour)
    const dayEndHour = clampHour(source.dayEndHour, DEFAULT_RETYPESET_APPEARANCE.dayEndHour)
    const allowManualOverride =
        typeof source.allowManualOverride === "boolean"
            ? source.allowManualOverride
            : DEFAULT_RETYPESET_APPEARANCE.allowManualOverride
    return { dayTheme, nightTheme, dayStartHour, dayEndHour, allowManualOverride }
}

function clampHour(value: unknown, fallback: number): number {
    const n = typeof value === "number" ? value : Number(value)
    if (!Number.isFinite(n)) return fallback
    const int = Math.trunc(n)
    if (int < 0) return 0
    if (int > 24) return 24
    return int
}
