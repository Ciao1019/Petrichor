import * as React from "react"
import { Bell, CheckCheck, Loader2 } from "lucide-react"
import { toast } from "sonner"

import {
  notificationApi,
  type NotificationItem as NotificationItemModel,
} from "@/lib/api"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { NotificationList } from "@/components/notification/notification-list"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import {
  emitNotificationRefresh,
  NOTIFICATION_REFRESH_EVENT,
} from "@/hooks/use-notification-center"

type ActionState = "read" | null

export function NotificationPage() {
  const [loading, setLoading] = React.useState(true)
  const [items, setItems] = React.useState<NotificationItemModel[]>([])
  const [actionLoadingById, setActionLoadingById] = React.useState<Record<string, ActionState>>({})
  const [markAllLoading, setMarkAllLoading] = React.useState(false)

  const loadMessages = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await notificationApi.list({
        pageNum: 1,
        pageSize: 50,
        orderByColumn: "createdAt",
        isAsc: "desc",
        readStatus: "ALL",
      })
      const nextItems = Array.isArray(res.data.rows) ? res.data.rows : []
      setItems(nextItems)
    } catch (error) {
      toast.error(resolveAxiosErrorMessage(error, "加载消息失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadMessages()
  }, [loadMessages])

  React.useEffect(() => {
    const handleRefresh = () => {
      void loadMessages()
    }
    window.addEventListener(NOTIFICATION_REFRESH_EVENT, handleRefresh)
    return () => window.removeEventListener(NOTIFICATION_REFRESH_EVENT, handleRefresh)
  }, [loadMessages])

  const withActionLoading = React.useCallback(async (id: string, action: Exclude<ActionState, null>, handler: () => Promise<void>) => {
    setActionLoadingById((prev) => ({ ...prev, [id]: action }))
    try {
      await handler()
    } finally {
      setActionLoadingById((prev) => ({ ...prev, [id]: null }))
    }
  }, [])

  const handleRead = React.useCallback(async (item: NotificationItemModel) => {
    await withActionLoading(item.id, "read", async () => {
      await notificationApi.read({ notificationId: item.id })
      emitNotificationRefresh()
      await loadMessages()
    })
  }, [loadMessages, withActionLoading])

  const handleReadAll = React.useCallback(async () => {
    setMarkAllLoading(true)
    try {
      await notificationApi.readAll({})
      toast.success("已全部标记为已读")
      emitNotificationRefresh()
      await loadMessages()
    } catch (error) {
      toast.error(resolveAxiosErrorMessage(error, "全部已读失败"))
    } finally {
      setMarkAllLoading(false)
    }
  }, [loadMessages])

  return (
    <div className="w-full p-4 lg:p-6">
      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2">
                <Bell className="size-5" />
                消息中心
              </CardTitle>
              <CardDescription>
                在这里查看系统消息，并处理未读状态。
              </CardDescription>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void loadMessages()} disabled={loading}>
                {loading ? <Loader2 className="size-4 animate-spin" /> : null}
                刷新
              </Button>
              <Button type="button" variant="secondary" onClick={handleReadAll} disabled={markAllLoading}>
                {markAllLoading ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
                全部已读
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-6">
          <NotificationList
            items={items}
            loading={loading}
            actionLoadingById={actionLoadingById}
            onRead={(item) => void handleRead(item)}
            emptyText="暂无消息"
          />
        </CardContent>
      </Card>
    </div>
  )
}

export default NotificationPage
