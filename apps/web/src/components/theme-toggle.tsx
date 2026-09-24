import { cn } from '@/lib/utils'
import { useTheme } from '@/components/theme-provider'

interface ThemeToggleProps {
  className?: string
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const isDark = resolvedTheme === 'dark'

  return (
    <button
      className={cn(
        "relative inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-transform motion-reduce:transition-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "motion-safe:active:scale-90",
        className,
      )}
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      type="button"
      aria-label={isDark ? '切换到浅色模式' : '切换到深色模式'}
      title={isDark ? '切换到浅色模式' : '切换到深色模式'}
    >
      <span className="relative block size-5 shrink-0" aria-hidden="true">
        {/* 月亮 (深色模式) */}
        <span
          className={cn(
            "absolute inset-0 z-10 h-full w-full rounded-full bg-gradient-to-tr from-indigo-400 to-sky-200",
            "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none",
            isDark ? "scale-100 opacity-100 rotate-0" : "scale-0 opacity-0 rotate-90",
          )}
        />
        {/* 太阳 (浅色模式) */}
        <span
          className={cn(
            "absolute inset-0 z-10 h-full w-full rounded-full bg-gradient-to-tr from-rose-400 to-amber-300",
            "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none",
            !isDark ? "scale-100 opacity-100 rotate-0" : "scale-0 opacity-0 -rotate-90",
          )}
        />
        {/* 月亮缺口 */}
        <span
          className={cn(
            "absolute top-0 right-0 z-20 size-2.5 origin-top-right rounded-full bg-[var(--theme-toggle-cutout,var(--sidebar))]",
            "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:transition-none",
            isDark ? "scale-100 opacity-100" : "scale-0 opacity-0",
          )}
        />
      </span>
    </button>
  )
}
