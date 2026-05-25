import * as React from "react"
import { useNavigate } from "react-router-dom"

import type { NotificationItem } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import DynamicIslandNotification from "@/cuicui/application-ui/notification/dynamic-island-notification/dynamic-island-notification"

type DynamicIslandBridgeProps = {
  notification: NotificationItem | null
  onDismiss: () => void
}

export function DynamicIslandBridge({ notification, onDismiss }: DynamicIslandBridgeProps) {
  const navigate = useNavigate()
  const [activeNotification, setActiveNotification] = React.useState<NotificationItem | null>(null)
  const [showNotification, setShowNotification] = React.useState(false)

  React.useEffect(() => {
    if (!notification) return
    setActiveNotification(notification)
    setShowNotification(true)

    const timer = window.setTimeout(() => {
      setShowNotification(false)
      window.setTimeout(() => {
        setActiveNotification(null)
        onDismiss()
      }, 220)
    }, 4500)

    return () => window.clearTimeout(timer)
  }, [notification, onDismiss])

  if (!activeNotification) return null

  return (
    <DynamicIslandNotification
      title={activeNotification.title}
      showNotification={showNotification}
      closeNotification={() => {
        setShowNotification(false)
        window.setTimeout(() => {
          setActiveNotification(null)
          onDismiss()
        }, 220)
      }}
      onClick={() => {
        navigate(dashboardRoutes.notifications)
        setShowNotification(false)
        window.setTimeout(() => {
          setActiveNotification(null)
          onDismiss()
        }, 220)
      }}
    >
      {activeNotification.content}
    </DynamicIslandNotification>
  )
}
