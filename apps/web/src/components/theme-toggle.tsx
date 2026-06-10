import { cn } from '@/lib/utils'
import { useTheme } from '@/components/theme-provider'

interface ThemeToggleProps {
  className?: string
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme()
  const isDark = theme === 'dark'

  return (
    <button
      className={cn(
        "relative size-5 cursor-pointer rounded-full outline-none transition-transform",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "active:scale-90",
        className,
      )}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      type="button"
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
      title={isDark ? '切换到浅色模式' : '切换到深色模式'}
    >
      {/* 月亮 (深色模式) */}
      <span
        className={cn(
          "absolute inset-0 z-10 h-full w-full rounded-full bg-gradient-to-tr from-indigo-400 to-sky-200",
          "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          isDark ? "scale-100 opacity-100 rotate-0" : "scale-0 opacity-0 rotate-90",
        )}
      />
      {/* 太阳 (浅色模式) */}
      <span
        className={cn(
          "absolute inset-0 z-10 h-full w-full rounded-full bg-gradient-to-tr from-rose-400 to-amber-300",
          "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          !isDark ? "scale-100 opacity-100 rotate-0" : "scale-0 opacity-0 -rotate-90",
        )}
      />
      {/* 月亮缺口 */}
      <span
        className={cn(
          "absolute top-0 right-0 z-20 size-2.5 origin-top-right rounded-full bg-sidebar",
          "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          isDark ? "scale-100 opacity-100" : "scale-0 opacity-0",
        )}
      />
    </button>
  )
}
