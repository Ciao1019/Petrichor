export type RetypesetThemeId = "sakura"
export type RetypesetThemeTone = "light"

export const FIXED_RETYPESET_THEME_ID: RetypesetThemeId = "sakura"
export const RETYPESET_THEME_ATTR = "data-retypeset-theme"

export interface RetypesetThemeDefinition {
    id: RetypesetThemeId
    label: string
    tone: RetypesetThemeTone
    primary: string
    secondary: string
    background: string
    surfaceTint: string
    highlight: string
    accent: string
}

export const FIXED_RETYPESET_THEME: RetypesetThemeDefinition = {
    id: FIXED_RETYPESET_THEME_ID,
    label: "Sakura 樱粉",
    tone: "light",
    primary: "oklch(24% 0.04 8)",
    secondary: "oklch(34% 0.045 8)",
    background: "oklch(96% 0.022 12)",
    surfaceTint: "oklch(24% 0.08 8)",
    highlight: "oklch(0.82 0.18 6 / 0.5)",
    accent: "oklch(50% 0.2 8)",
}

export interface RetypesetAppearanceConfig {
    /** 是否开启前台公开问答（/ask 页面） */
    publicQaEnabled: boolean
}

export type RetypesetAppearanceInput = Partial<Record<keyof RetypesetAppearanceConfig, unknown>>

export const DEFAULT_RETYPESET_APPEARANCE: RetypesetAppearanceConfig = {
    publicQaEnabled: true,
}

export function normalizeAppearance(
    raw: RetypesetAppearanceInput | null | undefined,
): RetypesetAppearanceConfig {
    const source = raw ?? {}
    return {
        publicQaEnabled:
            typeof source.publicQaEnabled === "boolean"
                ? source.publicQaEnabled
                : DEFAULT_RETYPESET_APPEARANCE.publicQaEnabled,
    }
}
