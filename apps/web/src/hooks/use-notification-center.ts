import * as React from "react"

import { notificationApi, type NotificationItem } from "@/lib/api"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"

export const NOTIFICATION_REFRESH_EVENT = "notification:refresh"

export function emitNotificationRefresh() {
  if (typeof window === "undefined") return
  window.dispatchEvent(new Event(NOTIFICATION_REFRESH_EVENT))
}

export function useNotificationCenter() {
  const [unreadCount, setUnreadCount] = React.useState(0)
  const [latestUnreadId, setLatestUnreadId] = React.useState<string | null>(null)
  const [recentItems, setRecentItems] = React.useState<NotificationItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [latestNotification, setLatestNotification] = React.useState<NotificationItem | null>(null)

  const initializedRef = React.useRef(false)
  const lastUnreadIdRef = React.useRef<string | null>(null)

  const refresh = React.useCallback(async (silent = true) => {
    try {
      const [summaryRes, listRes] = await Promise.all([
        notificationApi.summary(),
        notificationApi.list({
          pageNum: 1,
          pageSize: 6,
          orderByColumn: "createdAt",
          isAsc: "desc",
          readStatus: "ALL",
        }),
      ])

      const nextUnreadCount = summaryRes.data.unreadCount || 0
      const nextLatestUnreadId = summaryRes.data.latestUnreadId || null
      const nextRecentItems = listRes.data.rows || []

      setUnreadCount(nextUnreadCount)
      setLatestUnreadId(nextLatestUnreadId)
      setRecentItems(nextRecentItems)

      if (
        initializedRef.current &&
        nextLatestUnreadId &&
        nextLatestUnreadId !== lastUnreadIdRef.current
      ) {
        const nextLatest =
          nextRecentItems.find((item) => item.id === nextLatestUnreadId) ||
          nextRecentItems.find((item) => !item.read) ||
          null
        setLatestNotification(nextLatest)
      }

      lastUnreadIdRef.current = nextLatestUnreadId
      initializedRef.current = true
    } catch (error) {
      if (!silent) {
        throw error
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    let disposed = false

    const runRefresh = async (silent = true) => {
      if (disposed) return
      try {
        await refresh(silent)
      } catch (error) {
        if (!disposed) {
          console.error("刷新消息中心失败", error)
        }
      }
    }

    void runRefresh(true)

    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      void runRefresh(true)
    }, 25000)

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return
      void runRefresh(true)
    }
    const handleExternalRefresh = () => {
      void runRefresh(true)
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener(NOTIFICATION_REFRESH_EVENT, handleExternalRefresh)

    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener(NOTIFICATION_REFRESH_EVENT, handleExternalRefresh)
    }
  }, [refresh])

  const manualRefresh = React.useCallback(async () => {
    try {
      await refresh(false)
    } catch (error) {
      throw new Error(resolveAxiosErrorMessage(error, "刷新消息中心失败"))
    }
  }, [refresh])

  const dismissLatestNotification = React.useCallback(() => {
    setLatestNotification(null)
  }, [])

  return {
    unreadCount,
    latestUnreadId,
    recentItems,
    loading,
    latestNotification,
    dismissLatestNotification,
    refresh: manualRefresh,
  }
}
