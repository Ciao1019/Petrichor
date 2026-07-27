"use client"

import * as React from "react"
import { Theme } from "@astryxdesign/core/theme"
import { neutralTheme } from "@astryxdesign/theme-neutral/built"

import { useTheme } from "@/components/theme-provider"

/**
 * Astryx 设计系统的局部主题容器。
 *
 * 仅包裹用到 @astryxdesign/core 组件的子树，避免影响全站样式。
 * 通过应用现有的 ThemeProvider 同步明暗模式，使 Astryx 组件与站点主题保持一致。
 */
export function AstryxProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme()
  return (
    <Theme theme={neutralTheme} mode={theme}>
      {children}
    </Theme>
  )
}
