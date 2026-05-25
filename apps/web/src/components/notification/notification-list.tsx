import type { NotificationItem as NotificationItemModel } from "@/lib/api"
import { NotificationItem } from "@/components/notification/notification-item"

type NotificationListProps = {
  items: NotificationItemModel[]
  loading?: boolean
  actionLoadingById?: Record<string, "read" | null>
  onRead?: (item: NotificationItemModel) => void
  emptyText?: string
}

export function NotificationList({
  items,
  loading = false,
  actionLoadingById = {},
  onRead,
  emptyText = "暂无消息",
}: NotificationListProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-24 rounded-xl border bg-muted/40" />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-6 py-12 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {items.map((item) => (
        <NotificationItem
          key={item.id}
          item={item}
          actionLoading={actionLoadingById[item.id] || null}
          onRead={onRead}
        />
      ))}
    </div>
  )
}
