"use client"

import * as React from "react"
import { Copy, Link2, Pencil, RefreshCw } from "@/components/iconimate"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { authApi, type UserProfileResponse } from "@/lib/api"
import { PasswordFields } from "@/components/account/PasswordFields"
import { validatePasswordStrength } from "@/components/account/password-utils"
import { LoginSessionsSection } from "@/components/account/login-sessions-section"
import { NoticeToast } from "@/components/petrichor-ui/notice-toast"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function normalizeAxiosErrorMessage(e: unknown, fallback: string): string {
  if (typeof e === "object" && e && "response" in e) {
    const response = (e as { response?: { data?: { msg?: unknown } } }).response
    const apiMsg = response?.data?.msg
    if (typeof apiMsg === "string" && apiMsg) {
      return apiMsg
    }
  }
  if (e instanceof Error && e.message) {
    return e.message
  }
  return fallback
}

function toUserTypeLabel(value?: string | null) {
  const raw = typeof value === "string" ? value : ""
  if (raw === "LOCAL") return "本地注册"
  if (raw === "LINUXDO") return "LinuxDo 三方登录"
  return raw || "-"
}

function normalizeOptionalString(value?: string | null) {
  if (typeof value !== "string") return ""
  const text = value.trim()
  return text ? text : ""
}

function maskEmailForDisplay(value?: string | null) {
  const email = normalizeOptionalString(value)
  if (!email) return ""
  const atIndex = email.indexOf("@")
  if (atIndex <= 0) return email
  const local = email.slice(0, atIndex)
  const domain = email.slice(atIndex + 1)
  if (!domain) return email

  if (local.length <= 1) return `*@${domain}`
  if (local.length === 2) return `${local.slice(0, 1)}*@${domain}`

  let prefixLength = 1
  let suffixLength = 1
  if (local.length > 6 && local.length <= 10) {
    prefixLength = 2
    suffixLength = 2
  } else if (local.length > 10) {
    prefixLength = 6
    suffixLength = 4
  }

  const prefix = local.slice(0, prefixLength)
  const suffix = local.slice(-suffixLength)
  return `${prefix}***${suffix}@${domain}`
}

function formatLinuxDoAccount(profile: UserProfileResponse) {
  const username = normalizeOptionalString(profile.linuxDoUsername)
  const email = normalizeOptionalString(profile.linuxDoEmail)
  if (username && email) return `@${username} · ${email}`
  if (username) return `@${username}`
  if (email) return email
  return "已绑定"
}

async function copyToClipboard(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(`已复制${label}`)
  } catch {
    toast.error("复制失败")
  }
}

function ProfileField({
  label,
  value,
  copyLabel,
  copyValue,
}: {
  label: string
  value?: string | null
  copyLabel?: string
  copyValue?: string | undefined
}) {
  const normalizedValue = (value || "").trim()
  const normalizedCopyValue = (copyValue ?? value ?? "").trim()
  const displayValue = normalizedValue || "-"

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-2.5 text-sm gap-1">
      <span className="text-muted-foreground text-sm sm:w-36 shrink-0">{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-foreground break-all">{displayValue}</span>
        {copyLabel && normalizedCopyValue ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => void copyToClipboard(normalizedCopyValue, copyLabel)}
            aria-label={`复制${copyLabel}`}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function AccountPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [profile, setProfile] = React.useState<UserProfileResponse | null>(null)
  const [editOpen, setEditOpen] = React.useState(false)
  const [savingProfile, setSavingProfile] = React.useState(false)
  const [changingPassword, setChangingPassword] = React.useState(false)
  const [bindingLinuxDo, setBindingLinuxDo] = React.useState(false)
  const linuxDoBindingToastShownRef = React.useRef(false)
  const profileDraftSnapshotRef = React.useRef<{
    nickname: string
    avatar: string
    signature: string
  } | null>(null)

  const [nicknameDraft, setNicknameDraft] = React.useState("")
  const [avatarDraft, setAvatarDraft] = React.useState("")
  const [signatureDraft, setSignatureDraft] = React.useState("")
  const [currentPassword, setCurrentPassword] = React.useState("")
  const [newPassword, setNewPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")

  const fetchProfile = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await authApi.profile()
      setProfile(res.data)
    } catch (err) {
      setProfile(null)
      setError(normalizeAxiosErrorMessage(err, "请求失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void fetchProfile()
  }, [fetchProfile])

  React.useEffect(() => {
    if (searchParams.get("linuxdoBinding") !== "success") return
    if (!linuxDoBindingToastShownRef.current) {
      linuxDoBindingToastShownRef.current = true
      toast.success("Linux.do 账号已绑定")
    }
    const next = new URLSearchParams(searchParams)
    next.delete("linuxdoBinding")
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  React.useEffect(() => {
    if (!editOpen || !profile) return
    const snapshot = {
      nickname: normalizeOptionalString(profile.nickname),
      avatar: normalizeOptionalString(profile.avatar),
      signature: normalizeOptionalString(profile.signature),
    }
    profileDraftSnapshotRef.current = snapshot
    setNicknameDraft(snapshot.nickname)
    setAvatarDraft(snapshot.avatar)
    setSignatureDraft(snapshot.signature)
    setCurrentPassword("")
    setNewPassword("")
    setConfirmPassword("")
  }, [editOpen, profile])

  const isLocalUser = profile?.userType === "LOCAL"
  const emailText = normalizeOptionalString(profile?.email)
  const signatureText = normalizeOptionalString(profile?.signature)
  const maskedEmailText = maskEmailForDisplay(emailText)
  const isProfileIncomplete = Boolean(
    profile &&
      (!normalizeOptionalString(profile.nickname) ||
        !normalizeOptionalString(profile.avatar) ||
        !normalizeOptionalString(profile.signature)),
  )

  const isProfileDraftDirty = () => {
    const snapshot = profileDraftSnapshotRef.current
    if (!snapshot) return false
    return (
      normalizeOptionalString(nicknameDraft) !== snapshot.nickname ||
      normalizeOptionalString(avatarDraft) !== snapshot.avatar ||
      normalizeOptionalString(signatureDraft) !== snapshot.signature
    )
  }

  const handleEditOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setEditOpen(true)
      return
    }

    if (savingProfile) return

    if (isProfileDraftDirty()) {
      toast.custom(
        () => <NoticeToast title="更改未保存" description="您已取消编辑，未点击“保存”的更改不会生效。" />,
        {
          duration: 2500,
          position: "bottom-right",
          unstyled: true,
        }
      )
    }
    setEditOpen(false)
  }

  const openEditDialog = () => {
    setEditOpen(true)
  }

  const saveProfile = async () => {
    if (!profile) return
    setSavingProfile(true)
    try {
      const res = await authApi.updateProfile({
        nickname: nicknameDraft.trim() || null,
        avatar: avatarDraft.trim() || null,
        signature: signatureDraft.trim() || null,
      })
      setProfile(res.data)
      toast.custom(() => <NoticeToast tone="success" title="资料已更新" description="您的更改已保存成功。" />, {
        duration: 3500,
        position: "bottom-right",
        unstyled: true,
      })
      setEditOpen(false)
    } catch (e) {
      toast.error(normalizeAxiosErrorMessage(e, "更新失败"))
    } finally {
      setSavingProfile(false)
    }
  }

  const changePassword = async () => {
    if (!isLocalUser) {
      toast.error("第三方登录账号不支持修改密码")
      return
    }
    const current = currentPassword.trim()
    const next = newPassword.trim()
    const confirm = confirmPassword.trim()
    if (!current) {
      toast.error("请填写当前密码")
      return
    }
    const strengthError = validatePasswordStrength(next)
    if (strengthError) {
      toast.error(strengthError)
      return
    }
    if (next !== confirm) {
      toast.error("两次输入的新密码不一致")
      return
    }

    setChangingPassword(true)
    try {
      await authApi.changePassword({ currentPassword: current, newPassword: next })
      setCurrentPassword("")
      setNewPassword("")
      setConfirmPassword("")
      toast.success("密码已更新")
    } catch (e) {
      toast.error(normalizeAxiosErrorMessage(e, "修改密码失败"))
    } finally {
      setChangingPassword(false)
    }
  }

  const startLinuxDoBinding = () => {
    setBindingLinuxDo(true)
    window.location.assign("/api/auth/linuxdo/bind/start")
  }

  if (loading && !profile) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto w-full max-w-3xl space-y-8">
          <div className="flex items-center justify-between pb-6 border-b border-border/40">
            <div className="space-y-2">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-56" />
            </div>
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
          <div className="flex items-center gap-4 pb-6 border-b border-border/40">
            <Skeleton className="h-16 w-16 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-56" />
            </div>
          </div>
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        {/* 页头：标题、状态、操作 */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-border/50">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight text-foreground">账号资料</h1>
              {isProfileIncomplete ? (
                <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                  资料待完善
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">
              查看与管理当前登录账号的基础信息
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openEditDialog}
              disabled={loading || !profile}
            >
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              编辑
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void fetchProfile()}
              disabled={loading}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              刷新
            </Button>
          </div>
        </div>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>加载失败</AlertTitle>
            <AlertDescription className="break-all">
              {error}
            </AlertDescription>
          </Alert>
        ) : null}

        {profile ? (
          <>
            {/* 个人名片栏：头像 + 昵称/用户名 + 签名 */}
            <div className="flex items-start gap-4 sm:gap-5 pb-6 border-b border-border/40">
              <Avatar className="h-16 w-16 shrink-0 border border-border/60 shadow-xs">
                <AvatarImage src={profile.avatar || undefined} alt={profile.nickname || profile.username || "用户头像"} />
                <AvatarFallback className="text-lg font-semibold">
                  {(profile.nickname || profile.username || "U").slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="text-lg font-semibold tracking-tight text-foreground truncate">
                    {profile.nickname || profile.username || "未命名用户"}
                  </span>
                  <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {toUserTypeLabel(profile.userType)}
                  </span>
                </div>
                {signatureText ? (
                  <p className="text-sm text-muted-foreground italic leading-relaxed">
                    “{signatureText}”
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground/60">
                    暂未设置个性签名
                    <button
                      type="button"
                      onClick={openEditDialog}
                      className="ml-2 text-xs text-primary hover:underline"
                    >
                      去添加
                    </button>
                  </p>
                )}
              </div>
            </div>

            {/* 基础字段信息 */}
            <div className="space-y-2 pb-6 border-b border-border/40">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                基础信息
              </h2>
              <div className="divide-y divide-border/40">
                <ProfileField label="用户类型" value={toUserTypeLabel(profile.userType)} />
                <ProfileField label="用户名" value={profile.username} />
                <ProfileField label="昵称" value={profile.nickname} />
                <ProfileField label="邮箱" value={maskedEmailText} copyLabel="邮箱" copyValue={emailText || undefined} />
                <ProfileField label="创建时间" value={formatDateTime(profile.createdAt)} />
                <ProfileField label="更新时间" value={formatDateTime(profile.updatedAt)} />
              </div>
            </div>

            {/* 关联账号 */}
            <div className="space-y-2 pb-6 border-b border-border/40">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                关联账号
              </h2>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-1">
                <div className="min-w-0 space-y-0.5">
                  <div className="text-sm font-medium text-foreground">Linux.do 账号</div>
                  <div className="break-all text-sm text-muted-foreground">
                    {profile.linuxDoBound ? formatLinuxDoAccount(profile) : "未绑定第三方账号"}
                  </div>
                </div>
                {isLocalUser && !profile.linuxDoBound ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={startLinuxDoBinding}
                    disabled={bindingLinuxDo}
                  >
                    <Link2 className="h-3.5 w-3.5 mr-1.5" />
                    {bindingLinuxDo ? "跳转中..." : "绑定 Linux.do"}
                  </Button>
                ) : null}
              </div>
            </div>

            {/* 登录设备与会话 */}
            <LoginSessionsSection />

            <Dialog open={editOpen} onOpenChange={handleEditOpenChange}>
              <DialogContent showCloseButton={!savingProfile}>
                <DialogHeader>
                  <DialogTitle>编辑个人信息</DialogTitle>
                  <DialogDescription>
                    本地注册账号支持修改资料与密码；第三方登录账号仅支持修改资料。
                  </DialogDescription>
                </DialogHeader>

                <Tabs defaultValue="profile">
                  <TabsList className="w-full">
                    <TabsTrigger value="profile" className="flex-1">资料</TabsTrigger>
                    <TabsTrigger value="password" className="flex-1">密码</TabsTrigger>
                  </TabsList>

                  <TabsContent value="profile" className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="nickname">昵称</Label>
                      <Input
                        id="nickname"
                        value={nicknameDraft}
                        onChange={(e) => setNicknameDraft(e.target.value)}
                        placeholder="请输入昵称"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="avatar">头像</Label>
                      <Input
                        id="avatar"
                        value={avatarDraft}
                        onChange={(e) => setAvatarDraft(e.target.value)}
                        placeholder="请输入头像 URL（可留空）"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="signature">个性签名</Label>
                      <Textarea
                        id="signature"
                        value={signatureDraft}
                        onChange={(e) => setSignatureDraft(e.target.value)}
                        placeholder="请输入个性签名（可留空）"
                      />
                    </div>
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => handleEditOpenChange(false)}
                        disabled={savingProfile}
                      >
                        取消
                      </Button>
                      <Button type="button" onClick={() => void saveProfile()} disabled={savingProfile}>
                        {savingProfile ? "保存中..." : "保存"}
                      </Button>
                    </DialogFooter>
                  </TabsContent>

                  <TabsContent value="password" className="space-y-4">
                    {isLocalUser ? (
                      <>
                        <div className="space-y-2">
                          <Label htmlFor="currentPassword">当前密码</Label>
                          <Input
                            id="currentPassword"
                            type="password"
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            placeholder="请输入当前密码"
                          />
                        </div>
                        <PasswordFields
                          password={newPassword}
                          confirmPassword={confirmPassword}
                          onPasswordChange={setNewPassword}
                          onConfirmPasswordChange={setConfirmPassword}
                          passwordLabel="新密码"
                          confirmPasswordLabel="确认新密码"
                          passwordPlaceholder="至少 8 位，含大写字母、数字、特殊字符"
                          confirmPasswordPlaceholder="请再次输入新密码"
                        />
                        <DialogFooter>
                          <Button
                            type="button"
                            onClick={() => void changePassword()}
                            disabled={changingPassword}
                          >
                            {changingPassword ? "提交中..." : "修改密码"}
                          </Button>
                        </DialogFooter>
                      </>
                    ) : (
                      <div className="text-sm text-muted-foreground">
                        第三方登录账号暂不支持修改密码。
                      </div>
                    )}
                  </TabsContent>
                </Tabs>
              </DialogContent>
            </Dialog>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">
            暂无可展示的账号资料，请刷新重试。
          </div>
        )}
      </div>
    </div>
  )
}
