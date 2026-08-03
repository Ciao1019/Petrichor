"use client"

import type { ReactNode } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export type ModalShellProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 追加到 DialogContent 上的类名，用于调整宽度等。 */
  contentClassName?: string
  /** 追加到可滚动正文容器上的类名。 */
  bodyClassName?: string
  /** 为 true 时忽略遮罩点击 / ESC 等关闭请求，只能由业务代码显式关闭。 */
  disableClose?: boolean
}

/**
 * 项目统一的弹窗外壳：固定「头部 + 可滚动正文 + 底部操作区」三段式布局。
 * 正文区在内容超高时自行滚动，头尾始终可见，避免长表单把按钮顶出视口。
 */
export function ModalShell({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  contentClassName,
  bodyClassName,
  disableClose = false,
}: ModalShellProps) {
  const requestOpenChange = (nextOpen: boolean) => {
    // 锁定状态下只拦截「关闭」请求，打开请求依旧透传。
    if (disableClose && !nextOpen) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent className={cn("flex max-h-[calc(100vh-2rem)] flex-col sm:max-w-lg", contentClassName)}>
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-xl">{title}</DialogTitle>
          {description ? <DialogDescription className="text-base">{description}</DialogDescription> : null}
        </DialogHeader>

        <div className={cn("app-scrollbar min-h-0 flex-1 overflow-y-auto", bodyClassName)}>{children}</div>

        {footer ? <DialogFooter className="shrink-0">{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  )
}

export default ModalShell
