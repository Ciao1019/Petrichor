"use client"

import * as React from "react"
import { registerIcons } from "@astryxdesign/core/Icon"
import { ThemeContext, type DefinedTheme } from "@astryxdesign/core/theme"
import { neutralTheme } from "@astryxdesign/theme-neutral/built"

import { useTheme } from "@/components/theme-provider"

const typographyTokens = {
  "--font-family-body": "var(--font-luo)",
  "--font-family-heading": "var(--font-luo)",
  "--font-family-code": "var(--font-luo)",
  "--font-weight-normal": "400",
  "--font-weight-medium": "400",
  "--font-weight-semibold": "400",
  "--font-weight-bold": "400",
} as const

const localTheme: DefinedTheme = {
  ...neutralTheme,
  tokens: { ...neutralTheme.tokens, ...typographyTokens },
}

if (localTheme.icons) registerIcons(localTheme.icons)

/**
 * Astryx 设计系统的局部主题容器。
 *
 * 0.1.8 的 Theme 会把主题属性同步到 html，导致 prose reset 覆盖整个站点；
 * 它没有关闭该行为的选项，因此使用导出的 ThemeContext 与局部 CSS 作用域。
 * 预编译主题样式已由 globals.css 引入，无需再次注入或修改根节点。
 */
export function AstryxProvider({
  children,
  mode,
}: {
  children: React.ReactNode
  mode?: "light" | "dark" | "system"
}) {
  const { resolvedTheme } = useTheme()
  const effectiveMode = mode ?? resolvedTheme
  const context = React.useMemo(
    () => ({ theme: localTheme, mode: effectiveMode }),
    [effectiveMode],
  )

  return (
    <ThemeContext value={context}>
      <div
        data-astryx-theme={localTheme.name}
        data-theme={effectiveMode === "system" ? undefined : effectiveMode}
        style={{
          ...typographyTokens,
          display: "contents",
          color: "var(--color-text-primary)",
          colorScheme: effectiveMode === "system" ? "light dark" : effectiveMode,
          fontFamily: "var(--font-luo)",
          fontWeight: 400,
        }}
      >
        {children}
      </div>
    </ThemeContext>
  )
}
