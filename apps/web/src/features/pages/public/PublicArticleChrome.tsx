import { DotIcon } from "lucide-react"

import { SiteLogo } from "@/components/site-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"

type PublicArticleTopBarProps = {
  shareUrl: string
}

export function PublicArticleTopBar({ shareUrl }: PublicArticleTopBarProps) {
  return (
    <header data-public-article-header="true" className="sticky top-0 z-10 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
        <div className="flex items-center gap-3">
          <SiteLogo className="size-8 rounded-lg" size={32} />
          <div className="leading-tight">
            <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Petrichor</div>
            <div className="text-sm font-medium">公开文章</div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!shareUrl}
            onClick={() => {
              if (!shareUrl) return
              void navigator.clipboard.writeText(shareUrl)
            }}
          >
            复制链接
          </Button>
        </div>
      </div>
    </header>
  )
}

type PublicArticleErrorCardProps = {
  error: string
}

export function PublicArticleErrorCard({ error }: PublicArticleErrorCardProps) {
  return (
    <Card className="border-white/15 bg-white/[0.08] text-white shadow-none backdrop-blur-md">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-yellow-300">无法打开</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-white/75">
        <div className="text-white">{error}</div>
        <div>可能原因：链接无效、已撤销分享、或文章已删除。</div>
      </CardContent>
    </Card>
  )
}

type PublicArticlePasswordCardProps = {
  passwordId: string
  accessPassword: string
  loading: boolean
  error: string | null
  onAccessPasswordChange: (next: string) => void
  onSubmit: () => void
}

export function PublicArticlePasswordCard({
  passwordId,
  accessPassword,
  loading,
  error,
  onAccessPasswordChange,
  onSubmit,
}: PublicArticlePasswordCardProps) {
  return (
    <Card className="border-white/15 bg-white/[0.08] text-white shadow-none backdrop-blur-md">
      <CardHeader className="pb-2">
        <CardTitle className="text-base text-yellow-300">请输入访问密码</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <Label htmlFor={passwordId} className="text-white/80">6 位数字密码</Label>
        <InputOTP id={passwordId} maxLength={6} value={accessPassword} onChange={(v) => onAccessPasswordChange(v.replace(/\D/g, ""))}>
          <InputOTPGroup>
            <InputOTPSlot index={0} className="border-white/20 bg-white/10 text-white data-[active=true]:border-yellow-300 data-[active=true]:ring-yellow-300/40" />
            <InputOTPSlot index={1} className="border-white/20 bg-white/10 text-white data-[active=true]:border-yellow-300 data-[active=true]:ring-yellow-300/40" />
            <InputOTPSlot index={2} className="border-white/20 bg-white/10 text-white data-[active=true]:border-yellow-300 data-[active=true]:ring-yellow-300/40" />
          </InputOTPGroup>
          <div role="separator" className="text-white/50">
            <DotIcon />
          </div>
          <InputOTPGroup>
            <InputOTPSlot index={3} className="border-white/20 bg-white/10 text-white data-[active=true]:border-yellow-300 data-[active=true]:ring-yellow-300/40" />
            <InputOTPSlot index={4} className="border-white/20 bg-white/10 text-white data-[active=true]:border-yellow-300 data-[active=true]:ring-yellow-300/40" />
            <InputOTPSlot index={5} className="border-white/20 bg-white/10 text-white data-[active=true]:border-yellow-300 data-[active=true]:ring-yellow-300/40" />
          </InputOTPGroup>
        </InputOTP>
        <div className="flex items-center gap-2">
          <Button
            onClick={onSubmit}
            disabled={loading || accessPassword.length < 6}
            className="bg-yellow-300 text-blue-950 hover:bg-white"
          >
            {loading ? "验证中..." : "验证密码"}
          </Button>
          {error ? <span className="text-sm text-yellow-200">{error}</span> : null}
        </div>
      </CardContent>
    </Card>
  )
}
