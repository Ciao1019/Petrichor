"use client"

import * as React from "react"
import { ShieldAlert } from "lucide-react"
import { Link, useLocation } from "react-router-dom"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { authApi } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"

export function TwoFactorEnforcementBanner() {
  const location = useLocation()
  const [show, setShow] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    authApi.profile()
      .then((res) => {
        if (cancelled) return
        const profile = res.data
        const needsSetup =
          profile.userType === "LOCAL" &&
          profile.systemRole === "SUPER_ADMIN" &&
          !profile.twoFactorEnabled
        setShow(needsSetup)
      })
      .catch(() => {
        if (!cancelled) setShow(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!show) return null
  if (location.pathname === dashboardRoutes.account) return null

  return (
    <div className="px-4 pt-4 lg:px-6">
      <Alert>
        <ShieldAlert className="h-4 w-4" />
        <AlertTitle>建议启用二步验证</AlertTitle>
        <AlertDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span>
            你是超级管理员，账号尚未启用 TOTP 二步验证，建议立即配置以加固账号安全。
          </span>
          <Button asChild size="sm" variant="outline">
            <Link to={dashboardRoutes.account}>去启用</Link>
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}
