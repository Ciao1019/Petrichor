"use client"

import type { ReactNode } from "react"

import { CircleCheckIcon } from "lucide-react"
import { toast } from "sonner"

export type NotifyOptions = {
  /** 自定义前置图标；不传时使用成功态对勾。 */
  icon?: ReactNode
  duration?: number
}

/**
 * 轻量成功提示：一行文字 + 一个前置图标。
 * 复制 ID、保存成功一类「说完就走」的反馈都走这里，保证全站样式一致。
 */
export function notify(message: ReactNode, options?: NotifyOptions) {
  const icon = options?.icon ?? <CircleCheckIcon className="size-5 shrink-0" />

  return toast(
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-sm leading-snug">{message}</span>
    </div>,
    options?.duration === undefined ? undefined : { duration: options.duration }
  )
}

export default notify
