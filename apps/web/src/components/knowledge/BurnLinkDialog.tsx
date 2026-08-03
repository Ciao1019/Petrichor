import { Copy, DotIcon, Flame, Lock } from "lucide-react"

import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CalendarWave } from "@/components/ui/calendar-wave"
import { Input } from "@/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { OTP_LENGTH } from "@/components/knowledge/article-share-utils"
import { parseDateKey, toDateKey } from "@/components/knowledge/useArticleShareDialogState"
import {
  BURN_MAX_VIEWS_LIMIT,
  burnLinkUrl,
  useBurnLinkDialogState,
} from "@/components/knowledge/useBurnLinkDialogState"
import type { BurnLinkRecordResponse } from "@/lib/api"

type BurnLinkDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  articleId?: string
}

function burnStatusBadge(link: BurnLinkRecordResponse) {
  if (link.status === "BURNED") {
    return <Badge variant="destructive">已焚毁</Badge>
  }
  if (link.status === "REVOKED") {
    return <Badge variant="secondary">已撤销</Badge>
  }
  return <Badge variant="outline">可访问</Badge>
}

function BurnLinkRow({
  link,
  revoking,
  onCopy,
  onRevoke,
}: {
  link: BurnLinkRecordResponse
  revoking: boolean
  onCopy: (linkCode: string) => void
  onRevoke: (id: string) => void
}) {
  const url = burnLinkUrl(link.linkCode)
  const expiresLabel = link.expiresAt ? new Date(link.expiresAt).toLocaleString() : null
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex gap-2">
        <Input value={url} readOnly className="text-xs" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={link.status !== "ACTIVE"}
          onClick={() => onCopy(link.linkCode)}
        >
          <Copy className="size-4" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {burnStatusBadge(link)}
        <span>已读 {link.viewCount}/{link.maxViews} 次</span>
        {link.hasPassword ? (
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3" />密码
          </span>
        ) : null}
        {expiresLabel ? <span>到期 {expiresLabel}</span> : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 px-2 text-destructive hover:text-destructive"
          disabled={link.status !== "ACTIVE" || revoking}
          onClick={() => onRevoke(link.id)}
        >
          {revoking ? "撤销中..." : "撤销"}
        </Button>
      </div>
    </div>
  )
}

export function BurnLinkDialog({ open, onOpenChange, articleId }: BurnLinkDialogProps) {
  const otpId = "burn-dialog-password-otp"
  const {
    loadingList,
    creating,
    revokingId,
    links,
    maxViews,
    usePassword,
    password,
    enableExpire,
    expireDate,
    setMaxViews,
    setUsePasswordChecked,
    setPassword,
    setEnableExpire,
    setExpireDate,
    createLink,
    revokeLink,
    copyLink,
  } = useBurnLinkDialogState({ open, articleId })

  const footer = (
    <div className="flex w-full items-center justify-end gap-2">
      <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
        关闭
      </Button>
      <Button
        type="button"
        onClick={() => {
          void createLink()
        }}
        disabled={creating || loadingList}
      >
        {creating ? "生成中..." : "生成链接"}
      </Button>
    </div>
  )

  return (
    <ModalShell
      open={open}
      onOpenChange={onOpenChange}
      title="阅后即焚链接"
      description="生成一次性 / 限定次数的私密访问链接。链接不会出现在公开列表，也不会被问答检索。"
      footer={footer}
    >
      <div className="space-y-5 p-1">
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-2">
            <Label htmlFor="burn-max-views">最多可访问次数（1 = 阅后即焚）</Label>
            <Input
              id="burn-max-views"
              type="number"
              inputMode="numeric"
              min={1}
              max={BURN_MAX_VIEWS_LIMIT}
              value={Number.isFinite(maxViews) ? maxViews : 1}
              onChange={(event) => {
                const next = Number(event.target.value)
                setMaxViews(Number.isFinite(next) ? next : 1)
              }}
            />
            <p className="text-xs text-muted-foreground">
              访问者需在确认页点击「确认阅读」才会消耗一次；达到次数后链接立即销毁。
            </p>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="burn-password-switch">启用访问密码</Label>
            <Switch
              id="burn-password-switch"
              checked={usePassword}
              onCheckedChange={(value) => setUsePasswordChecked(Boolean(value))}
            />
          </div>
          {usePassword ? (
            <div className="flex justify-center">
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
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <Label htmlFor="burn-expire-switch">启用到期时间</Label>
            <Switch
              id="burn-expire-switch"
              checked={enableExpire}
              onCheckedChange={(value) => setEnableExpire(Boolean(value))}
            />
          </div>
          {enableExpire ? (
            <div className="flex justify-center">
              <CalendarWave
                value={toDateKey(expireDate)}
                onChange={(value) => {
                  const nextDate = parseDateKey(value)
                  if (nextDate) setExpireDate(nextDate)
                }}
              />
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-1.5">
            <Flame className="size-3.5" />已生成的链接
          </Label>
          {loadingList ? (
            <div className="text-xs text-muted-foreground">加载中...</div>
          ) : links.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              还没有生成过阅后即焚链接。
            </div>
          ) : (
            <div className="space-y-2">
              {links.map((link) => (
                <BurnLinkRow
                  key={link.id}
                  link={link}
                  revoking={revokingId === link.id}
                  onCopy={(linkCode) => {
                    void copyLink(linkCode)
                  }}
                  onRevoke={(id) => {
                    void revokeLink(id)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  )
}
