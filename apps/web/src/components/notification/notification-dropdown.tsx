import type { ReactNode } from "react"

import {
  Bell,
  CheckCheck,
  ChevronRight,
} from "lucide-react"

import type { NotificationItem as NotificationItemModel } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NotificationItem } from "@/components/notification/notification-item"

type NotificationDropdownProps = {
  trigger: ReactNode
  unreadCount: number
  items: NotificationItemModel[]
  loading?: boolean
  onOpenNotifications: () => void
  onRead?: (item: NotificationItemModel) => void
  onMarkAllRead?: () => void
}

export function NotificationDropdown({
  trigger,
  unreadCount,
  items,
  loading = false,
  onOpenNotifications,
  onRead,
  onMarkAllRead,
}: NotificationDropdownProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent className="w-[min(92vw,28rem)] p-0" align="end">
        <DropdownMenuLabel className="flex flex-col gap-3 border-b px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Bell className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold">消息中心</span>
            </div>
            <Badge variant="secondary">{unreadCount} 条未读</Badge>
          </div>
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={onMarkAllRead}>
              <CheckCheck className="size-4" />
              全部已读
            </Button>
          </div>
        </DropdownMenuLabel>

        <div className="max-h-[24rem] overflow-y-auto p-2">
          {loading ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="h-20 rounded-lg bg-muted/40" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              暂无消息
            </div>
          ) : (
            items.map((item) => (
              <div key={item.id} className="rounded-lg transition-colors hover:bg-muted/50">
                <NotificationItem item={item} compact onRead={onRead} />
              </div>
            ))
          )}
        </div>

        <DropdownMenuSeparator />
        <div className="p-2">
          <Button type="button" variant="ghost" className="w-full justify-between" onClick={onOpenNotifications}>
            查看全部消息
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
