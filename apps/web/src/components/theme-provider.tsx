import { createContext, useContext, useLayoutEffect, useState } from 'react'

type Theme = 'dark' | 'light' | 'system'

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  forcedTheme?: Exclude<Theme, 'system'>
  storageKey?: string
}

type ThemeProviderState = {
  /** 用户的偏好设置（可能是 'system'），主题切换器读它来显示当前选项 */
  theme: Theme
  /**
   * 实际生效的主题：已解析 'system'、且已应用 forcedTheme。
   * 判断"现在到底是不是暗色"必须用它——前台公开页强制暗色，
   * 但用户 localStorage 里可能存着 'light'，读 theme 会得到错误结论。
   */
  resolvedTheme: Exclude<Theme, 'system'>
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

  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useLayoutEffect(() => {
    if (effectiveTheme !== 'system' || typeof window === 'undefined') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [effectiveTheme])

  const resolvedTheme: Exclude<Theme, 'system'> =
    effectiveTheme === 'system' ? (systemDark ? 'dark' : 'light') : effectiveTheme

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
    resolvedTheme,
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
