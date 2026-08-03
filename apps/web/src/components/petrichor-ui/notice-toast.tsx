import type { ReactNode } from "react"

import { CheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "@/lib/utils"

export type NoticeTone = "info" | "success" | "warning"

type ToneStyle = {
  icon: typeof InfoIcon
  border: string
  accent: string
}

const TONE_STYLES: Record<NoticeTone, ToneStyle> = {
  info: {
    icon: InfoIcon,
    border: "border-primary/20",
    accent: "text-primary",
  },
  success: {
    icon: CheckIcon,
    border: "border-emerald-500/25 dark:border-emerald-400/25",
    accent: "text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    icon: TriangleAlertIcon,
    border: "border-amber-500/25 dark:border-amber-400/25",
    accent: "text-amber-600 dark:text-amber-400",
  },
}

export type NoticeToastProps = {
  title: ReactNode
  description?: ReactNode
  tone?: NoticeTone
  className?: string
}

/**
 * 浮层提示卡片，配合 `toast.custom(..., { unstyled: true })` 使用。
 *
 * sonner 的默认样式在 unstyled 模式下不会生效，所以这里自带宽度、投影和描边；
 * 语气（tone）只影响图标和描边配色，排版在三种语气之间保持一致。
 */
export function NoticeToast({ title, description, tone = "info", className }: NoticeToastProps) {
  const { icon: ToneIcon, border, accent } = TONE_STYLES[tone]

  return (
    <Alert className={cn("app-noise w-[360px] max-w-[calc(100vw-2rem)] bg-card shadow-lg", border, className)}>
      <ToneIcon className={accent} />
      <AlertTitle>{title}</AlertTitle>
      {description ? <AlertDescription className="text-muted-foreground">{description}</AlertDescription> : null}
    </Alert>
  )
}

export default NoticeToast
