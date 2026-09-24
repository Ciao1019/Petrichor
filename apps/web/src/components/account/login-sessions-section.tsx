"use client"

import * as React from "react"
import { Laptop, LogOut, MapPin, Monitor, RefreshCw, Smartphone } from "@/components/iconimate"
import { toast } from "sonner"

import { authSessionApi, type AuthSessionItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"

type RevokeTarget =
  | { kind: "single"; session: AuthSessionItem }
  | { kind: "others"; count: number }

function normalizeAxiosError(e: unknown, fallback: string): string {
  if (typeof e === "object" && e && "response" in e) {
    const response = (e as { response?: { data?: { msg?: unknown } } }).response
    const msg = response?.data?.msg
    if (typeof msg === "string" && msg) {
      return msg
    }
  }
  if (e instanceof Error && e.message) {
    return e.message
  }
  return fallback
}

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

// 根据 User-Agent 粗略识别设备与浏览器，仅用于展示，不追求绝对精确。
function describeUserAgent(ua?: string | null): { device: string; isMobile: boolean } {
  const raw = (ua || "").trim()
  if (!raw) return { device: "未知设备", isMobile: false }

  const isMobile = /Mobile|Android|iPhone|iPad|iPod/i.test(raw)

  let os = ""
  if (/Windows/i.test(raw)) os = "Windows"
  else if (/iPhone|iPad|iPod/i.test(raw)) os = "iOS"
  else if (/Mac OS X|Macintosh/i.test(raw)) os = "macOS"
  else if (/Android/i.test(raw)) os = "Android"
  else if (/Linux/i.test(raw)) os = "Linux"

  let browser = ""
  if (/Edg\//i.test(raw)) browser = "Edge"
  else if (/OPR\/|Opera/i.test(raw)) browser = "Opera"
  else if (/Chrome\//i.test(raw)) browser = "Chrome"
  else if (/Firefox\//i.test(raw)) browser = "Firefox"
  else if (/Safari\//i.test(raw)) browser = "Safari"

  const parts = [os, browser].filter(Boolean)
  return { device: parts.length ? parts.join(" · ") : "未知设备", isMobile }
}

export function LoginSessionsSection() {
  const [loading, setLoading] = React.useState(false)
  const [sessions, setSessions] = React.useState<AuthSessionItem[]>([])
  const [revokeTarget, setRevokeTarget] = React.useState<RevokeTarget | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  const fetchSessions = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await authSessionApi.list()
      if (!Array.isArray(res.data?.sessions)) {
        throw new Error("登录会话响应格式异常")
      }
      setSessions(res.data.sessions)
    } catch (e) {
      toast.error(normalizeAxiosError(e, "加载登录设备失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchSessions()
  }, [fetchSessions])

  const otherSessions = sessions.filter((s) => !s.current)
  const closeDialog = () => {
    if (submitting) return
    setRevokeTarget(null)
  }

  const openRevokeSingle = (session: AuthSessionItem) => {
    setRevokeTarget({ kind: "single", session })
  }

  const openRevokeOthers = () => {
    setRevokeTarget({ kind: "others", count: otherSessions.length })
  }

  const submitRevoke = async () => {
    if (!revokeTarget) return
    setSubmitting(true)
    try {
      if (revokeTarget.kind === "single") {
        await authSessionApi.revoke(revokeTarget.session.id)
        toast.success("已下线该设备")
      } else {
        const res = await authSessionApi.revokeOthers()
        toast.success(`已下线 ${res.data.revokedCount} 个其他设备`)
      }
      setRevokeTarget(null)
      await fetchSessions()
    } catch (e) {
      toast.error(normalizeAxiosError(e, "下线失败，请重试"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            <Monitor className="h-3.5 w-3.5" />
            登录设备与地点
          </div>
          <div className="text-xs text-muted-foreground">
            查看当前账户的所有登录会话，发现异地登录可下线对应设备。
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => void fetchSessions()} disabled={loading}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" />
            刷新
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openRevokeOthers}
            disabled={loading || otherSessions.length === 0}
          >
            <LogOut className="h-3.5 w-3.5 mr-1" />
            一键下线其他设备
          </Button>
        </div>
      </div>

      <div className="mt-2 divide-y divide-border/40">
        {loading && sessions.length === 0 ? (
          <div className="space-y-3 py-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            暂无登录会话记录。
          </div>
        ) : (
          sessions.map((session) => {
            const { device, isMobile } = describeUserAgent(session.userAgent)
            const DeviceIcon = isMobile ? Smartphone : Laptop
            return (
              <div
                key={session.id}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <DeviceIcon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{device}</span>
                      {session.current ? (
                        <Badge variant="secondary" className="text-xs">当前设备</Badge>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        <span className="break-all">IP：{session.ip || "未知"}</span>
                      </span>
                      <span>·</span>
                      <span>最近活跃：{formatDateTime(session.lastSeenAt ?? session.updatedAt)}</span>
                    </div>
                  </div>
                </div>
                {session.current ? (
                  <span className="text-xs text-muted-foreground self-end sm:self-center">本次登录</span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-xs text-destructive hover:bg-destructive/10 hover:text-destructive self-end sm:self-center"
                    onClick={() => openRevokeSingle(session)}
                  >
                    <LogOut className="h-3.5 w-3.5 mr-1" />
                    下线
                  </Button>
                )}
              </div>
            )
          })
        )}
      </div>

      <Dialog open={revokeTarget !== null} onOpenChange={(next) => (next ? null : closeDialog())}>
        <DialogContent showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>
              {revokeTarget?.kind === "others" ? "一键下线其他设备" : "下线该设备"}
            </DialogTitle>
            <DialogDescription>
              {revokeTarget?.kind === "others"
                ? `将下线除当前设备外的 ${revokeTarget.count} 个登录会话。`
                : "下线后该设备需要重新登录。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={closeDialog}>取消</Button>
            <Button type="button" disabled={submitting} onClick={() => void submitRevoke()}>
              {submitting ? "提交中..." : "确认下线"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
