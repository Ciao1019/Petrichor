import { Copy, DotIcon } from "lucide-react"

import { KbDialog } from "@/components/shadcn-studio/dialog/dialog-09"
import { Button } from "@/components/ui/button"
import { CalendarWave } from "@/components/ui/calendar-wave"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { OTP_LENGTH } from "@/components/knowledge/article-share-utils"
import {
  parseDateKey,
  toDateKey,
  useArticleShareDialogState,
} from "@/components/knowledge/useArticleShareDialogState"

type ArticleShareDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  articleId?: string
}

const maskedOtpSlotClassName =
  "dark:bg-input/30 border-input relative flex h-9 w-9 items-center justify-center border-y border-r text-sm text-muted-foreground shadow-xs first:rounded-l-md first:border-l last:rounded-r-md"

function MaskedOTPSlot() {
  return <div className={maskedOtpSlotClassName}>•</div>
}

function MaskedPasswordOtp() {
  return (
    <div className="flex items-center gap-2">
      <InputOTPGroup>
        <MaskedOTPSlot />
        <MaskedOTPSlot />
        <MaskedOTPSlot />
      </InputOTPGroup>
      <div role="separator" className="text-muted-foreground">
        <DotIcon className="size-4" />
      </div>
      <InputOTPGroup>
        <MaskedOTPSlot />
        <MaskedOTPSlot />
        <MaskedOTPSlot />
      </InputOTPGroup>
    </div>
  )
}

export function ArticleShareDialog({ open, onOpenChange, articleId }: ArticleShareDialogProps) {
  const otpId = "share-dialog-password-otp"
  const originalUrlId = "share-dialog-original-url"
  const originalAuthorNameId = "share-dialog-original-author-name"
  const {
    loadingInfo,
    submitting,
    revoking,
    shareCode,
    hasPassword,
    enableExpire,
    expireDate,
    usePassword,
    editingPassword,
    password,
    isRepost,
    originalUrl,
    originalAuthorName,
    shareUrl,
    expireEcho,
    setEnableExpire,
    setExpireDate,
    setUsePasswordChecked,
    setIsRepostChecked,
    setEditingPassword,
    setPassword,
    setOriginalUrl,
    setOriginalAuthorName,
    saveShareSettings,
    revokeShare,
    copyShareLink,
  } = useArticleShareDialogState({ open, articleId })

  const footer = (
    <div className="flex w-full items-center justify-between gap-2">
      <Button
        type="button"
        variant="destructive"
        onClick={() => {
          void revokeShare()
        }}
        disabled={!shareCode || revoking || submitting || loadingInfo}
      >
        {revoking ? "撤销中..." : "撤销分享"}
      </Button>
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          关闭
        </Button>
        <Button
          type="button"
          onClick={() => {
            void saveShareSettings("分享设置已更新")
          }}
          disabled={submitting || loadingInfo}
        >
          {submitting ? "保存中..." : "保存并生成链接"}
        </Button>
      </div>
    </div>
  )

  return (
    <KbDialog
      open={open}
      onOpenChange={onOpenChange}
      title="分享文章"
      description="可配置到期时间与访问密码。保存后将生成或更新公开链接。"
      footer={footer}
    >
      <div className="space-y-5 p-1">
        <div className="space-y-2">
          <Label>分享链接</Label>
          <div className="flex gap-2">
            <Input value={shareUrl || "尚未生成"} readOnly />
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={!shareUrl}
              onClick={() => {
                void copyShareLink()
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>

        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="share-repost-switch">转载文章</Label>
            <Switch id="share-repost-switch" checked={isRepost} onCheckedChange={(value) => setIsRepostChecked(Boolean(value))} />
          </div>
          {isRepost ? (
            <div className="grid gap-3">
              <div className="space-y-2">
                <Label htmlFor={originalUrlId}>原文链接</Label>
                <Input
                  id={originalUrlId}
                  type="url"
                  inputMode="url"
                  value={originalUrl}
                  onChange={(event) => setOriginalUrl(event.target.value)}
                  placeholder="https://example.com/article"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={originalAuthorNameId}>原作者</Label>
                <Input
                  id={originalAuthorNameId}
                  value={originalAuthorName}
                  onChange={(event) => setOriginalAuthorName(event.target.value)}
                  placeholder="作者名称"
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="share-expire-switch">启用到期时间</Label>
            <Switch id="share-expire-switch" checked={enableExpire} onCheckedChange={(value) => setEnableExpire(Boolean(value))} />
          </div>
          {enableExpire ? (
            <div className="space-y-2">
              <div className="flex justify-center">
                <CalendarWave
                  value={toDateKey(expireDate)}
                  onChange={(value) => {
                    const nextDate = parseDateKey(value)
                    if (nextDate) setExpireDate(nextDate)
                  }}
                />
              </div>
              {expireEcho ? <div className="text-center text-xs text-muted-foreground">到期时间：{expireEcho}</div> : null}
            </div>
          ) : null}
        </div>

        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="share-password-switch">启用访问密码</Label>
            <Switch id="share-password-switch" checked={usePassword} onCheckedChange={(value) => setUsePasswordChecked(Boolean(value))} />
          </div>
          {usePassword ? (
            <div className="space-y-2">
              <div className="flex justify-center">
                {hasPassword && !editingPassword ? (
                  <MaskedPasswordOtp />
                ) : (
                  <InputOTP
                    id={otpId}
                    maxLength={OTP_LENGTH}
                    value={password}
                    onChange={(value) => setPassword(value.replace(/\D/g, ""))}
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                    </InputOTPGroup>
                    <div role="separator" className="text-muted-foreground">
                      <DotIcon className="size-4" />
                    </div>
                    <InputOTPGroup>
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
                )}
              </div>
              {hasPassword ? (
                <div className="flex justify-center">
                  {editingPassword ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditingPassword(false)
                        setPassword("")
                      }}
                    >
                      保持原密码
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditingPassword(true)}>
                      修改密码
                    </Button>
                  )}
                </div>
              ) : null}
              {hasPassword ? (
                <div className="text-center text-xs text-muted-foreground">
                  {editingPassword ? "输入新密码后保存生效。" : "当前链接已设置过访问密码，未修改将保持原密码。"}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </KbDialog>
  )
}
