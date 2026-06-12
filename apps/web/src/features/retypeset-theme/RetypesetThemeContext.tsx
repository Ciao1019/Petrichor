"use client"

import * as React from "react"
import {
    FIXED_RETYPESET_THEME,
    FIXED_RETYPESET_THEME_ID,
    RETYPESET_THEME_ATTR,
    type RetypesetThemeId,
    type RetypesetThemeTone,
} from "@/lib/retypeset-themes"

export interface RetypesetThemeState {
    activeTheme: RetypesetThemeId
    activeTone: RetypesetThemeTone
}

const fixedState: RetypesetThemeState = {
    activeTheme: FIXED_RETYPESET_THEME_ID,
    activeTone: FIXED_RETYPESET_THEME.tone,
}

const RetypesetThemeContext = React.createContext<RetypesetThemeState>(fixedState)

type RetypesetThemeProviderProps = {
    children: React.ReactNode
}

export function RetypesetThemeProvider({ children }: RetypesetThemeProviderProps) {
    React.useEffect(() => {
        document.documentElement.setAttribute(RETYPESET_THEME_ATTR, FIXED_RETYPESET_THEME_ID)
    }, [])

    return (
        <RetypesetThemeContext.Provider value={fixedState}>
            {children}
        </RetypesetThemeContext.Provider>
    )
}

export function useRetypesetTheme(): RetypesetThemeState {
    return React.useContext(RetypesetThemeContext)
}

export function useOptionalRetypesetTheme(): RetypesetThemeState {
    return React.useContext(RetypesetThemeContext)
}
