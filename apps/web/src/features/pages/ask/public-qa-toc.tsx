"use client"

import * as React from "react"
import { List } from "@/components/iconimate"

import { Button } from "@/components/ui/button"
import { useQaThreadToc } from "@/features/pages/assistant/assistant-toc"
import { MobileTocDrawer, PublicArticleFloatingToc } from "@/features/pages/public/PublicArticlePanels"

/**
 * 前台问答大纲：与文章详情页同一套目录交互。
 * 桌面端是右侧栏的悬浮目录（.ftoc，小屏由样式隐藏）；小屏在工具栏给「目录」入口，点开底部抽屉。
 * 条目、激活项与点击定位与后台对话大纲共用 useQaThreadToc。
 */
export function PublicQaToc() {
  const { items, activeId, selectItem } = useQaThreadToc()
  const [mobileOpen, setMobileOpen] = React.useState(false)

  if (items.length === 0) return null
  return (
    <>
      {/* .ftoc 的前台配色与侧栏定位挂在 .public-article--retypeset 下 */}
      <div className="public-article--retypeset">
        <PublicArticleFloatingToc navToc={items} activeHeadingId={activeId} onTocClick={selectItem} />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9 gap-1.5 rounded-lg text-muted-foreground hover:text-foreground lg:hidden"
        aria-label="打开对话大纲"
        onClick={() => setMobileOpen(true)}
      >
        <List className="size-4" aria-hidden />
        目录
      </Button>
      <MobileTocDrawer
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        navToc={items}
        activeHeadingId={activeId}
        onTocClick={selectItem}
      />
    </>
  )
}
