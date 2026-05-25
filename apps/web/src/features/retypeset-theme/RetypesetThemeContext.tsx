"use client"

import * as React from "react"
import {
    DEFAULT_RETYPESET_APPEARANCE,
    RETYPESET_INITIAL_APPEARANCE_GLOBAL,
    RETYPESET_THEME_ATTR,
    RETYPESET_THEME_STORAGE_AUTO,
    RETYPESET_THEME_STORAGE_KEY,
    isRetypesetThemeId,
    normalizeAppearance,
    resolveRetypesetActiveTheme,
    type RetypesetAppearanceConfig,
    type RetypesetAppearanceInput,
    type RetypesetThemeId,
    type RetypesetThemeTone,
} from "@/lib/retypeset-themes"
import { publicSiteAppearanceApi } from "@/lib/api"
import { RETYPESET_THEMES } from "@/lib/retypeset-themes"

export interface RetypesetThemeState {
    /** 当前生效的主题 id */
    activeTheme: RetypesetThemeId
    /** 当前主题的色调（light/dark），便于切换按钮显示对应图标 */
    activeTone: RetypesetThemeTone
    /** 是否处于用户手动覆盖模式（非自动跟时间） */
    isManualOverride: boolean
    /** 是否允许手动覆盖（来自后台配置） */
    allowManualOverride: boolean
    /** 后台外观配置（已 normalize） */
    appearance: RetypesetAppearanceConfig
    /** 切换到指定主题 id，触发 manual override 写入 localStorage */
    setTheme: (theme: RetypesetThemeId) => void
    /** 切换到自动跟时间模式，清掉 manual override */
    clearOverride: () => void
    /** 一键切换日/夜：当前是日则切夜，反之亦然 */
    toggleDayNight: () => void
}

const RetypesetThemeContext = React.createContext<RetypesetThemeState | null>(null)

type RetypesetThemeProviderProps = {
    children: React.ReactNode
    initialAppearance?: RetypesetAppearanceInput | null
}

declare global {
    interface Window {
        __RETYPESET_INITIAL_APPEARANCE__?: RetypesetAppearanceInput
    }
}

function readInitialAppearance(): RetypesetAppearanceConfig {
    if (typeof window === "undefined") return DEFAULT_RETYPESET_APPEARANCE
    return normalizeAppearance(window[RETYPESET_INITIAL_APPEARANCE_GLOBAL])
}

function readOverride(): RetypesetThemeId | null {
    if (typeof window === "undefined") return null
    try {
        const raw = window.localStorage.getItem(RETYPESET_THEME_STORAGE_KEY)
        if (!raw || raw === RETYPESET_THEME_STORAGE_AUTO) return null
        return isRetypesetThemeId(raw) ? raw : null
    } catch {
        return null
    }
}

function writeOverride(value: RetypesetThemeId | null) {
    if (typeof window === "undefined") return
    try {
        if (value == null) {
            window.localStorage.setItem(RETYPESET_THEME_STORAGE_KEY, RETYPESET_THEME_STORAGE_AUTO)
        } else {
            window.localStorage.setItem(RETYPESET_THEME_STORAGE_KEY, value)
        }
    } catch {
        // ignore storage errors
    }
}

function applyToDocument(theme: RetypesetThemeId) {
    if (typeof document === "undefined") return
    document.documentElement.setAttribute(RETYPESET_THEME_ATTR, theme)
}

export function RetypesetThemeProvider({ children, initialAppearance }: RetypesetThemeProviderProps) {
    const [appearance, setAppearance] = React.useState<RetypesetAppearanceConfig>(
        () => normalizeAppearance(initialAppearance ?? readInitialAppearance()),
    )
    const [override, setOverride] = React.useState<RetypesetThemeId | null>(() => readOverride())
    const [hour, setHour] = React.useState<number>(() => new Date().getHours())

    React.useEffect(() => {
        let cancelled = false
        publicSiteAppearanceApi
            .detail()
            .then((res) => {
                if (cancelled) return
                const data = res.data
                if (!data) return
                setAppearance(normalizeAppearance(data))
            })
            .catch(() => {
                // 静默失败：保持默认主题
            })
        return () => {
            cancelled = true
        }
    }, [])

    React.useEffect(() => {
        const tick = () => setHour(new Date().getHours())
        tick()
        const interval = window.setInterval(tick, 60_000)
        return () => window.clearInterval(interval)
    }, [])

    React.useEffect(() => {
        const handleStorage = (event: StorageEvent) => {
            if (event.key !== RETYPESET_THEME_STORAGE_KEY) return
            setOverride(readOverride())
        }
        window.addEventListener("storage", handleStorage)
        return () => window.removeEventListener("storage", handleStorage)
    }, [])

    const allowManualOverride = appearance.allowManualOverride
    const effectiveOverride = allowManualOverride ? override : null
    const activeTheme = resolveRetypesetActiveTheme(appearance, hour, effectiveOverride)
    const activeTone = RETYPESET_THEMES[activeTheme].tone

    React.useEffect(() => {
        applyToDocument(activeTheme)
    }, [activeTheme])

    const setTheme = React.useCallback((next: RetypesetThemeId) => {
        if (!isRetypesetThemeId(next)) return
        setOverride(next)
        writeOverride(next)
    }, [])

    const clearOverride = React.useCallback(() => {
        setOverride(null)
        writeOverride(null)
    }, [])

    const toggleDayNight = React.useCallback(() => {
        const isCurrentlyDay = activeTone === "light"
        const next = isCurrentlyDay ? appearance.nightTheme : appearance.dayTheme
        if (next === activeTheme) {
            // 已经是目标，不必写
            return
        }
        setOverride(next)
        writeOverride(next)
    }, [activeTheme, activeTone, appearance.dayTheme, appearance.nightTheme])

    const value = React.useMemo<RetypesetThemeState>(
        () => ({
            activeTheme,
            activeTone,
            isManualOverride: effectiveOverride != null,
            allowManualOverride,
            appearance,
            setTheme,
            clearOverride,
            toggleDayNight,
        }),
        [
            activeTheme,
            activeTone,
            effectiveOverride,
            allowManualOverride,
            appearance,
            setTheme,
            clearOverride,
            toggleDayNight,
        ],
    )

    return <RetypesetThemeContext.Provider value={value}>{children}</RetypesetThemeContext.Provider>
}

export function useRetypesetTheme(): RetypesetThemeState {
    const ctx = React.useContext(RetypesetThemeContext)
    if (!ctx) {
        throw new Error("useRetypesetTheme 必须在 RetypesetThemeProvider 内使用")
    }
    return ctx
}

export function useOptionalRetypesetTheme(): RetypesetThemeState | null {
    return React.useContext(RetypesetThemeContext)
}
