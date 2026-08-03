"use client"

import type { ComponentProps, MouseEvent, ReactNode } from "react"

import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

type ContentAlign = ComponentProps<typeof DropdownMenuContent>["align"]

export type ActionMenuProps = {
  /** 触发元素，会以 asChild 形式挂载，需要能接收 ref 与事件。 */
  trigger: ReactNode
  children: ReactNode
  align?: ContentAlign
  sideOffset?: number
  contentClassName?: string
}

/**
 * 列表行 / 卡片上的「更多操作」菜单。
 *
 * 这类菜单常常嵌在可点击的行或卡片里，因此触发器和面板都会吞掉 click 冒泡，
 * 避免打开菜单的同时又触发了外层的跳转或选中。
 */
export function ActionMenu({ trigger, children, align = "end", sideOffset, contentClassName }: ActionMenuProps) {
  const stopBubbling = (event: MouseEvent) => {
    event.stopPropagation()
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={stopBubbling}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        sideOffset={sideOffset}
        className={contentClassName}
        onClick={stopBubbling}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default ActionMenu
