import { Check, Clock3, Loader2 } from "lucide-react"

import type { NotificationItem as NotificationItemModel } from "@/lib/api"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import {
  formatNotificationTime,
  getNotificationInitials,
} from "@/components/notification/notification-utils"

type NotificationItemProps = {
  item: NotificationItemModel
  compact?: boolean
  actionLoading?: "read" | null
  onRead?: (item: NotificationItemModel) => void
}

export function NotificationItem({
  item,
  compact = false,
  actionLoading = null,
  onRead,
}: NotificationItemProps) {
  return (
    <div
      className={cn(
        "flex gap-3 px-4 py-3",
        !compact && "rounded-xl border bg-card"
      )}
    >
      <Avatar className="size-10 shrink-0">
        <AvatarFallback>{getNotificationInitials(item)}</AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{item.title}</div>
            <div className="mt-1 text-sm text-muted-foreground">{item.content}</div>
          </div>

          <div className="flex items-center gap-2">
            {!item.read ? <div className="size-2 rounded-full bg-primary" /> : null}
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {formatNotificationTime(item.createdAt)}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{item.category}</Badge>
          {!item.read ? <Badge variant="secondary">未读</Badge> : null}
          {item.read ? (
            <Badge variant="secondary">
              <Clock3 className="mr-1 size-3" />
              已读
            </Badge>
          ) : null}
        </div>

        {!item.read ? (
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={Boolean(actionLoading)}
              onClick={() => onRead?.(item)}
            >
              {actionLoading === "read" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              标记已读
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
