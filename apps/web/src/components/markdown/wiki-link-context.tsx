"use client"

import * as React from "react"

import { wikiScribbleStyle } from "@/components/markdown/wiki-scribble"

/** 从 #wiki-page=<encoded> 链接里解出 pageKey；非该类链接返回 null。 */
export function readWikiPageKeyFromHref(href: string | undefined | null): string | null {
  if (typeof href !== "string" || !href.startsWith("#wiki-page=")) return null
  try {
    return decodeURIComponent(href.slice("#wiki-page=".length)) || null
  } catch {
    return null
  }
}

/**
 * Wiki 内链点击回调：注册后回答里的 [[..]] 引用会渲染成带手绘波浪线的链接，
 * 点击交给调用方（通常是打开 Wiki 弹窗预览）；未注册时退化为不可跳转的锚点。
 */
const WikiLinkClickContext = React.createContext<((pageKey: string) => void) | null>(null)

export function WikiLinkClickProvider({
  onOpenWikiPage,
  children,
}: {
  onOpenWikiPage: (pageKey: string) => void
  children: React.ReactNode
}) {
  const handler = React.useMemo(() => onOpenWikiPage, [onOpenWikiPage])
  return <WikiLinkClickContext.Provider value={handler}>{children}</WikiLinkClickContext.Provider>
}

export function useOpenWikiPage() {
  return React.useContext(WikiLinkClickContext)
}

/**
 * 回答正文里的 Wiki 内链：去系统下划线，描一道按 pageKey 稳定取色的
 * 手绘马克笔波浪（与知识库「知识关联」视觉一致），点击交给弹窗。
 * 供 assistant-ui MarkdownTextPrimitive 与 LobeHub Markdown 两套渲染管线复用。
 */
export function WikiScribbleAnchor(props: React.ComponentProps<"a"> & { node?: unknown }) {
  const { href, children, style, node, className, ...rest } = props
  void node
  const pageKey = readWikiPageKeyFromHref(href)
  const onOpenWikiPage = useOpenWikiPage()
  if (!pageKey) return null
  return (
    <a
      href={href}
      className={
        className != null && className.length > 0
          ? className
          : "cursor-pointer font-medium underline-offset-4 hover:opacity-80"
      }
      title="点击查看 Wiki 页面"
      onClick={(event) => {
        event.preventDefault()
        onOpenWikiPage?.(pageKey)
      }}
      style={{ ...wikiScribbleStyle(pageKey), ...style }}
      {...rest}
    >
      {children}
    </a>
  )
}
