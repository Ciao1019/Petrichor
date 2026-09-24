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
   * 判断当前明暗必须用它，theme 只表示用户保存的偏好。
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
      try {
        const storedTheme = window.localStorage.getItem(storageKey)
        return storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'system'
          ? storedTheme
          : defaultTheme
      } catch {
        return defaultTheme
      }
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
    let cancelled = false

    const applyTheme = () => {
      if (cancelled) return
      root.classList.remove('light', 'dark')
      root.classList.add(resolvedTheme)
      root.style.colorScheme = resolvedTheme
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!root.classList.contains(resolvedTheme) && !reducedMotion && typeof document.startViewTransition === 'function') {
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
        return () => {
          // 快速连续切换时，旧快照回调不能覆盖最新选择。
          cancelled = true
          transition.skipTransition()
        }
      } catch {
        applyTheme()
      }
    } else {
      applyTheme()
    }
  }, [resolvedTheme])

  const value = {
    theme,
    resolvedTheme,
    setTheme: (theme: Theme) => {
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, theme)
        } catch {
          // 隐私模式或存储不可用时，仍允许当前页面切换主题。
        }
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
