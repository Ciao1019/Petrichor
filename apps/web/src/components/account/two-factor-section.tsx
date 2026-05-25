"use client"

import * as React from "react"
import { QRCodeSVG } from "qrcode.react"
import { Copy, KeyRound, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react"
import { toast } from "sonner"

import { twoFactorApi, type UserProfileResponse } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

type Props = {
  profile: UserProfileResponse | null
  onChanged: () => void
}

type Mode =
  | { kind: "idle" }
  | { kind: "enable-password" }
  | { kind: "enable-verify"; totpURI: string; secret: string; backupCodes: string[]; code: string }
  | { kind: "disable" }
  | { kind: "regen-codes" }
  | { kind: "regen-codes-result"; backupCodes: string[] }

function extractSecretFromOtpAuthUri(uri: string): string {
  try {
    const url = new URL(uri)
    return url.searchParams.get("secret")?.trim() ?? ""
  } catch {
    return ""
  }
}

function normalizeAxiosError(e: unknown, fallback: string): string {
  if (typeof e === "object" && e && "response" in e) {
    const response = (e as { response?: { data?: { msg?: unknown; message?: unknown } } }).response
    const msg = response?.data?.msg ?? response?.data?.message
    if (typeof msg === "string" && msg) {
      return msg
    }
  }
  if (e instanceof Error && e.message) {
    return e.message
  }
  return fallback
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`已复制${label}`)
  } catch {
    toast.error("复制失败")
  }
}

function BackupCodesPanel({ codes }: { codes: string[] }) {
  return (
    <div className="space-y-3">
      <div className="text-sm text-muted-foreground">
        请把以下一次性备份码妥善保存。每个备份码只能使用一次，建议截图或抄写后存到密码管理器。
      </div>
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-3 font-mono text-sm">
        {codes.map((code) => (
          <div key={code} className="select-all break-all">{code}</div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy(codes.join("\n"), "备份码")}
        >
          <Copy className="h-4 w-4 mr-1" />
          复制全部
        </Button>
      </div>
    </div>
  )
}

export function TwoFactorSection({ profile, onChanged }: Props) {
  const [mode, setMode] = React.useState<Mode>({ kind: "idle" })
  const [password, setPassword] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  const isLocalUser = profile?.userType === "LOCAL"
  const enabled = Boolean(profile?.twoFactorEnabled)

  const closeDialog = () => {
    if (submitting) return
    setMode({ kind: "idle" })
    setPassword("")
  }

  const openEnable = () => {
    setPassword("")
    setMode({ kind: "enable-password" })
  }

  const openDisable = () => {
    setPassword("")
    setMode({ kind: "disable" })
  }

  const openRegen = () => {
    setPassword("")
    setMode({ kind: "regen-codes" })
  }

  const submitEnable = async () => {
    const pwd = password.trim()
    if (!pwd) {
      toast.error("请输入当前密码")
      return
    }
    setSubmitting(true)
    try {
      const res = await twoFactorApi.enable({ password: pwd })
      const secret = extractSecretFromOtpAuthUri(res.data.totpURI)
      setMode({
        kind: "enable-verify",
        totpURI: res.data.totpURI,
        secret,
        backupCodes: res.data.backupCodes,
        code: "",
      })
      setPassword("")
    } catch (e) {
      toast.error(normalizeAxiosError(e, "启用二步验证失败"))
    } finally {
      setSubmitting(false)
    }
  }

  const submitVerify = async () => {
    if (mode.kind !== "enable-verify") return
    const code = mode.code.trim()
    if (!code) {
      toast.error("请输入 6 位 TOTP 验证码")
      return
    }
    setSubmitting(true)
    try {
      await twoFactorApi.verifyTotp({ code })
      toast.success("二步验证已启用")
      setMode({ kind: "idle" })
      onChanged()
    } catch (e) {
      toast.error(normalizeAxiosError(e, "验证码错误，请重试"))
    } finally {
      setSubmitting(false)
    }
  }

  const submitDisable = async () => {
    const pwd = password.trim()
    if (!pwd) {
      toast.error("请输入当前密码")
      return
    }
    setSubmitting(true)
    try {
      await twoFactorApi.disable({ password: pwd })
      toast.success("二步验证已关闭")
      setMode({ kind: "idle" })
      setPassword("")
      onChanged()
    } catch (e) {
      toast.error(normalizeAxiosError(e, "关闭二步验证失败"))
    } finally {
      setSubmitting(false)
    }
  }

  const submitRegen = async () => {
    const pwd = password.trim()
    if (!pwd) {
      toast.error("请输入当前密码")
      return
    }
    setSubmitting(true)
    try {
      const res = await twoFactorApi.generateBackupCodes({ password: pwd })
      setMode({ kind: "regen-codes-result", backupCodes: res.data.backupCodes })
      setPassword("")
    } catch (e) {
      toast.error(normalizeAxiosError(e, "生成备份码失败"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rounded-lg border px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            二步验证 (TOTP)
          </div>
          <div className="text-sm text-muted-foreground">
            {enabled
              ? "邮箱密码登录时需要额外输入 Authenticator 中的 6 位验证码。"
              : "为账号增加一层防护，建议使用 Authy / 1Password / Google Authenticator。"}
          </div>
          {!isLocalUser ? (
            <div className="text-xs text-muted-foreground">
              第三方登录账号无需也无法配置 TOTP。
            </div>
          ) : null}
        </div>
        {isLocalUser ? (
          enabled ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={openRegen}>
                <RefreshCw className="h-4 w-4 mr-1" />
                重新生成备份码
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={openDisable}>
                <ShieldOff className="h-4 w-4 mr-1" />
                关闭
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={openEnable}>
              <KeyRound className="h-4 w-4 mr-1" />
              启用二步验证
            </Button>
          )
        ) : null}
      </div>

      <Dialog
        open={mode.kind === "enable-password"}
        onOpenChange={(next) => (next ? null : closeDialog())}
      >
        <DialogContent showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>启用二步验证</DialogTitle>
            <DialogDescription>请输入当前账户密码以继续。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="enable2faPwd">当前密码</Label>
            <Input
              id="enable2faPwd"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={closeDialog}>取消</Button>
            <Button type="button" disabled={submitting} onClick={() => void submitEnable()}>
              {submitting ? "提交中..." : "下一步"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mode.kind === "enable-verify"}
        onOpenChange={(next) => (next ? null : closeDialog())}
      >
        <DialogContent showCloseButton={!submitting} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>扫码并完成验证</DialogTitle>
            <DialogDescription>
              使用 Authenticator 扫描下方二维码，输入应用显示的 6 位验证码以激活二步验证。
            </DialogDescription>
          </DialogHeader>
          {mode.kind === "enable-verify" ? (
            <div className="space-y-4">
              <div className="flex flex-col items-center gap-3 rounded-lg border bg-muted/30 p-4">
                <QRCodeSVG value={mode.totpURI} size={176} includeMargin />
                <div className="w-full space-y-1">
                  <div className="text-xs text-muted-foreground">手动输入密钥</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 select-all break-all rounded bg-background px-2 py-1 font-mono text-xs">
                      {mode.secret || "(无)"}
                    </code>
                    {mode.secret ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => void copy(mode.secret, "密钥")}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

              <BackupCodesPanel codes={mode.backupCodes} />

              <div className="space-y-2">
                <Label htmlFor="enable2faCode">6 位验证码</Label>
                <Input
                  id="enable2faCode"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={mode.code}
                  onChange={(e) => setMode({ ...mode, code: e.target.value })}
                  autoFocus
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={closeDialog}>稍后</Button>
            <Button type="button" disabled={submitting} onClick={() => void submitVerify()}>
              {submitting ? "验证中..." : "确认启用"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mode.kind === "disable"}
        onOpenChange={(next) => (next ? null : closeDialog())}
      >
        <DialogContent showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>关闭二步验证</DialogTitle>
            <DialogDescription>关闭后下次登录无需 TOTP，备份码会一并失效。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="disable2faPwd">当前密码</Label>
            <Input
              id="disable2faPwd"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={closeDialog}>取消</Button>
            <Button type="button" disabled={submitting} onClick={() => void submitDisable()}>
              {submitting ? "提交中..." : "确认关闭"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mode.kind === "regen-codes"}
        onOpenChange={(next) => (next ? null : closeDialog())}
      >
        <DialogContent showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>重新生成备份码</DialogTitle>
            <DialogDescription>旧的备份码会立即失效，请妥善保存新生成的备份码。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="regen2faPwd">当前密码</Label>
            <Input
              id="regen2faPwd"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={submitting} onClick={closeDialog}>取消</Button>
            <Button type="button" disabled={submitting} onClick={() => void submitRegen()}>
              {submitting ? "生成中..." : "生成"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={mode.kind === "regen-codes-result"}
        onOpenChange={(next) => (next ? null : closeDialog())}
      >
        <DialogContent showCloseButton={true} className="max-w-md">
          <DialogHeader>
            <DialogTitle>新的备份码</DialogTitle>
            <DialogDescription>
              这是新生成的备份码，旧的已立即失效。请保存到密码管理器或离线位置。
            </DialogDescription>
          </DialogHeader>
          {mode.kind === "regen-codes-result" ? <BackupCodesPanel codes={mode.backupCodes} /> : null}
          <DialogFooter>
            <Button type="button" onClick={closeDialog}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
