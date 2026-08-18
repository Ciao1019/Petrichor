"use client"

import * as React from "react"
import { Laptop, LogOut, MapPin, Monitor, RefreshCw, ShieldAlert, Smartphone } from "@/components/iconimate"
import { toast } from "sonner"

import { authSessionApi, type AuthSessionItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"

type Props = {
  twoFactorEnabled: boolean
}

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

export function LoginSessionsSection({ twoFactorEnabled }: Props) {
  const [loading, setLoading] = React.useState(false)
  const [sessions, setSessions] = React.useState<AuthSessionItem[]>([])
  const [serverTwoFactorEnabled, setServerTwoFactorEnabled] = React.useState(twoFactorEnabled)
  const [revokeTarget, setRevokeTarget] = React.useState<RevokeTarget | null>(null)
  const [code, setCode] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  const fetchSessions = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await authSessionApi.list()
      setSessions(res.data.sessions)
      setServerTwoFactorEnabled(res.data.twoFactorEnabled)
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
  const twoFactorReady = serverTwoFactorEnabled && twoFactorEnabled

  const closeDialog = () => {
    if (submitting) return
    setRevokeTarget(null)
    setCode("")
  }

  const openRevokeSingle = (session: AuthSessionItem) => {
    setCode("")
    setRevokeTarget({ kind: "single", session })
  }

  const openRevokeOthers = () => {
    setCode("")
    setRevokeTarget({ kind: "others", count: otherSessions.length })
  }

  const submitRevoke = async () => {
    if (!revokeTarget) return
    const trimmed = code.trim()
    if (!trimmed) {
      toast.error("请输入 6 位 TOTP 验证码")
      return
    }
    setSubmitting(true)
    try {
      if (revokeTarget.kind === "single") {
        await authSessionApi.revoke({ sessionId: revokeTarget.session.id, code: trimmed })
        toast.success("已下线该设备")
      } else {
        const res = await authSessionApi.revokeOthers({ code: trimmed })
        toast.success(`已下线 ${res.data.revokedCount} 个其他设备`)
      }
      setRevokeTarget(null)
      setCode("")
      await fetchSessions()
    } catch (e) {
      toast.error(normalizeAxiosError(e, "下线失败，请重试"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-lg border px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Monitor className="h-4 w-4" />
            登录设备与地点
          </div>
          <div className="text-sm text-muted-foreground">
            查看当前账户的所有登录会话，发现异地登录可下线对应设备。下线需验证 TOTP。
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void fetchSessions()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            刷新
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openRevokeOthers}
            disabled={loading || otherSessions.length === 0 || !twoFactorReady}
          >
            <LogOut className="h-4 w-4 mr-1" />
            一键下线其他设备
          </Button>
        </div>
      </div>

      {!twoFactorReady ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>下线设备需要先启用二步验证（TOTP）。请在上方“二步验证”中开启后再操作。</span>
        </div>
      ) : null}

      <div className="mt-4 space-y-3">
        {loading && sessions.length === 0 ? (
          <>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </>
        ) : sessions.length === 0 ? (
          <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            暂无登录会话记录。
          </div>
        ) : (
          sessions.map((session) => {
            const { device, isMobile } = describeUserAgent(session.userAgent)
            const DeviceIcon = isMobile ? Smartphone : Laptop
            return (
              <div
                key={session.id}
                className="flex flex-col gap-3 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <DeviceIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{device}</span>
                      {session.current ? (
                        <Badge variant="secondary" className="text-xs">当前设备</Badge>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      <span className="break-all">IP：{session.ip || "未知"}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      最近活跃：{formatDateTime(session.lastActiveAt)}
                    </div>
                  </div>
                </div>
                {session.current ? (
                  <span className="text-xs text-muted-foreground">本次登录</span>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openRevokeSingle(session)}
                    disabled={!twoFactorReady}
                  >
                    <LogOut className="h-4 w-4 mr-1" />
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
                ? `将下线除当前设备外的 ${revokeTarget.count} 个登录会话，请输入 Authenticator 中的 6 位验证码确认。`
                : "下线后该设备需要重新登录。请输入 Authenticator 中的 6 位验证码确认。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="revokeTotpCode">6 位验证码</Label>
            <Input
              id="revokeTotpCode"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
          </div>
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
