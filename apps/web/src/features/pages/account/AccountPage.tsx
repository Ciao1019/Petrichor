"use client"

import * as React from "react"
import { Copy, Link2, Pencil, QuoteIcon, RefreshCw } from "lucide-react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { authApi, type UserProfileResponse } from "@/lib/api"
import { PasswordFields } from "@/components/account/PasswordFields"
import { validatePasswordStrength } from "@/components/account/password-utils"
import { TwoFactorSection } from "@/components/account/two-factor-section"
import ProfileEditingAlert from "@/components/shadcn-studio/alert/alert-26"
import ProfileUpdateSuccessAlert from "@/components/shadcn-studio/alert/alert-27"
import ProfileIncompleteWarningAlert from "@/components/shadcn-studio/alert/alert-28"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2 text-sm">
        <span className="break-all">{displayValue}</span>
        {copyLabel && normalizedCopyValue ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => void copyToClipboard(normalizedCopyValue, copyLabel)}
            aria-label={`复制${copyLabel}`}
          >
            <Copy className="h-4 w-4" />
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
  const profileIncompleteToastShownRef = React.useRef(false)
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

  React.useEffect(() => {
    if (!profile || error) return
    if (profileIncompleteToastShownRef.current) return
    if (!isProfileIncomplete) return

    profileIncompleteToastShownRef.current = true
    toast.custom(() => <ProfileIncompleteWarningAlert />, {
      duration: 5000,
      position: "bottom-right",
      unstyled: true,
    })
  }, [profile, error, isProfileIncomplete])

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
      toast.custom(() => <ProfileEditingAlert />, {
        duration: 2500,
        position: "bottom-right",
        unstyled: true,
      })
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
      toast.custom(() => <ProfileUpdateSuccessAlert />, {
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
      <div className="@container/main flex flex-1 flex-col gap-2">
        <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6 px-4 lg:px-6">
          <Card className="mx-auto w-full max-w-3xl">
            <CardHeader>
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-64" />
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center gap-4">
                <Skeleton className="h-16 w-16 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-56" />
                </div>
              </div>
              <div className="space-y-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className="@container/main flex flex-1 flex-col gap-2">
      <div className="flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6 px-4 lg:px-6">
        <Card className="mx-auto w-full max-w-3xl">
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <CardTitle>账号资料</CardTitle>
                <CardDescription>查看当前登录账号的基础信息</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={openEditDialog}
                  disabled={loading || !profile}
                >
                  <Pencil className="h-4 w-4 mr-2" />
                  编辑
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void fetchProfile()}
                  disabled={loading}
                >
                  <RefreshCw className="h-4 w-4 mr-2" />
                  刷新
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
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
                <div className="flex items-center gap-4">
                  <Avatar className="h-16 w-16">
                    <AvatarImage src={profile.avatar || undefined} alt={profile.nickname || profile.username || "用户头像"} />
                    <AvatarFallback>
                      {(profile.nickname || profile.username || "U").slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <div className="text-lg font-semibold truncate">
                      {profile.nickname || profile.username || "未命名用户"}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm text-muted-foreground">个性签名</div>
                  {signatureText ? (
                    <BlockQuote author={profile.username || "用户"} quote={signatureText} />
                  ) : (
                    <div className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
                      未设置个性签名，点击右上角“编辑”进行添加。
                    </div>
                  )}
                </div>

                <div className="divide-y rounded-lg border px-4">
                  <ProfileField label="用户类型" value={toUserTypeLabel(profile.userType)} />
                  <ProfileField label="用户名" value={profile.username} />
                  <ProfileField label="昵称" value={profile.nickname} />
                  <ProfileField label="邮箱" value={maskedEmailText} copyLabel="邮箱" copyValue={emailText || undefined} />
                  <ProfileField label="创建时间" value={formatDateTime(profile.createdAt)} />
                  <ProfileField label="更新时间" value={formatDateTime(profile.updatedAt)} />
                </div>

                <div className="rounded-lg border px-4 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <div className="text-sm font-medium">Linux.do 账号</div>
                      <div className="break-all text-sm text-muted-foreground">
                        {profile.linuxDoBound ? formatLinuxDoAccount(profile) : "未绑定"}
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
                        <Link2 className="h-4 w-4 mr-2" />
                        {bindingLinuxDo ? "跳转中..." : "绑定 Linux.do"}
                      </Button>
                    ) : null}
                  </div>
                </div>

                <TwoFactorSection profile={profile} onChanged={() => void fetchProfile()} />

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
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

const BlockQuote = ({
  quote,
  author,
}: {
  quote: string
  author: string
}) => {
  return (
    <blockquote className="rounded-xl border-amber-500/70 border-l-4 bg-amber-500/15 px-4 py-2 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
      <p className="inline italic">
        <QuoteIcon
          aria-hidden="true"
          className="-translate-y-1 mr-1 inline size-3 fill-amber-700 stroke-none dark:fill-amber-400"
        />
        {quote}
        <QuoteIcon
          aria-hidden="true"
          className="ml-1 inline size-3 translate-y-1 fill-amber-700 stroke-none dark:fill-amber-400"
        />
      </p>
      <p className="mt-1.5 text-end font-semibold text-sm italic tracking-tighter">
        {author}
      </p>
    </blockquote>
  )
}
