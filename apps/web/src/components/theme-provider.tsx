import { createContext, useContext, useLayoutEffect, useState } from 'react'

type Theme = 'dark' | 'light' | 'system'

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  forcedTheme?: Exclude<Theme, 'system'>
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(undefined)

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  forcedTheme,
  storageKey = 'ui-theme',
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => {
      if (typeof window === 'undefined') {
        return defaultTheme
      }
      return (window.localStorage.getItem(storageKey) as Theme) || defaultTheme
    }
  )

  const effectiveTheme = forcedTheme ?? theme

  useLayoutEffect(() => {
    const root = window.document.documentElement

    const applyTheme = () => {
      root.classList.remove('light', 'dark')
      if (effectiveTheme === 'system') {
        const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        root.classList.add(systemTheme)
      } else {
        root.classList.add(effectiveTheme)
      }
    }

    if (typeof document.startViewTransition === 'function') {
      try {
        const transition = document.startViewTransition(applyTheme)
        transition.ready?.catch(() => {
          // 新的 ViewTransition 会取消旧的 transition，这里忽略取消异常
        })
        transition.updateCallbackDone?.catch(() => {
          // 更新回调被打断时忽略异常，避免未捕获 Promise
        })
        transition.finished.catch(() => {
          // 新的 ViewTransition 会取消旧的 transition，这里忽略取消异常
        })
      } catch {
        applyTheme()
      }
    } else {
      applyTheme()
    }
  }, [effectiveTheme])

  const value = {
    theme,
    setTheme: (theme: Theme) => {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, theme)
      }
      setTheme(theme)
    },
  }

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
