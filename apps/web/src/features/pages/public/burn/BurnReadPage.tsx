import { useParams } from "react-router-dom"
import { DotIcon, Flame } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { TiltCard } from "@/components/petrichor-ui/tilt-card"
import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import {
  PublicArticlePageView,
} from "@/features/pages/public/PublicArticlePageView"
import { useBurnReadModel } from "@/features/pages/public/burn/useBurnReadModel"

const otpSlotClassName =
  "border-white/20 bg-white/10 text-white data-[active=true]:border-yellow-300 data-[active=true]:ring-yellow-300/40"

// 复用文章详情页（/p/）的 retypeset 外壳：相同蓝底 + 网格 + 像素装饰 + 站点头/导航/页脚，
// 让阅后即焚的确认 / 失效 / 加载态与文章详情视觉一致。
function BurnShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="retypeset-home scrollbar-hide relative flex min-h-screen flex-col overflow-x-hidden bg-[#0044cc] text-white selection:bg-yellow-300 selection:text-blue-950">
      <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />

      <div className="relative z-30 mx-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pt-8 lg:contents">
        <RetypesetSiteHeader dockVisible />
        <RetypesetSiteNav activeSection="articles" dockVisible />
      </div>

      <section className="relative z-20 mx-auto flex w-full max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-10 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:my-20 lg:max-w-[min(calc(75vw-16rem),44rem)] lg:p-0">
        {children}
      </section>

      <div className="relative z-30 mx-auto mt-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pb-8 lg:contents">
        <RetypesetSiteFooter dockVisible />
      </div>
    </main>
  )
}

function BurnInfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="border-white/15 bg-white/[0.08] text-white shadow-none backdrop-blur-md">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Flame className="size-4 retypeset-c-primary" />
          <span className="retypeset-highlight-static retypeset-c-primary">{title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-white/80">{children}</CardContent>
    </Card>
  )
}

export function BurnReadPage() {
  const { code } = useParams()
  const model = useBurnReadModel(code)

  if (model.phase === "article") {
    return (
      <>
        <div
          className="relative z-40 flex items-center justify-center gap-2 px-4 py-1.5 text-center text-xs font-medium"
          style={{ backgroundColor: "var(--retypeset-highlight)", color: "var(--retypeset-primary)" }}
        >
          <Flame className="size-3.5" />
          {model.burnNotice?.burned
            ? "本链接为阅后即焚，本次为最后一次访问，关闭后将无法再次打开。"
            : `阅后即焚链接 · 已访问 ${model.burnNotice?.viewCount}/${model.burnNotice?.maxViews} 次，关闭后请勿依赖再次打开。`}
        </div>
        <PublicArticlePageView model={model.pageModel} />
      </>
    )
  }

  if (model.phase === "gone") {
    return (
      <BurnShell>
        <BurnInfoCard title="无法打开">
          <div className="text-white">{model.goneText}</div>
          <div className="text-white/60">阅后即焚链接仅可访问有限次数，达到上限后会被永久销毁。</div>
        </BurnInfoCard>
      </BurnShell>
    )
  }

  if (model.phase === "loading") {
    return (
      <BurnShell>
        <BurnInfoCard title="正在检查链接">
          <div className="text-white/70">请稍候...</div>
        </BurnInfoCard>
      </BurnShell>
    )
  }

  const consuming = model.phase === "consuming"
  return (
    <BurnShell>
      <TiltCard
        title={
          <span className="flex items-center gap-2 text-base">
            <Flame className="size-4 retypeset-c-primary" />
            <span className="retypeset-highlight-static retypeset-c-primary">阅后即焚</span>
          </span>
        }
        imageSrc={model.coverImageUrl}
        imageAlt="文章封面"
        imageClassName="h-auto object-contain"
        className="border-white/15 bg-white/[0.08] text-white shadow-none backdrop-blur-md"
        contentClassName="text-sm text-white/80"
      >
        <p className="leading-relaxed">
          这是一个<strong className="retypeset-c-primary">阅后即焚</strong>链接。点击下方「确认阅读」后将消耗一次访问次数；
          达到上限后链接会被<strong className="retypeset-c-primary">永久销毁</strong>，且无法再次访问。请确认已准备好阅读再继续。
        </p>

        {model.requiresPassword ? (
          <div className="space-y-2">
            <Label className="text-white/80">访问密码（6 位数字）</Label>
            <InputOTP
              maxLength={6}
              value={model.accessPassword}
              onChange={(value) => model.onAccessPasswordChange(value.replace(/\D/g, ""))}
            >
              <InputOTPGroup>
                <InputOTPSlot index={0} className={otpSlotClassName} />
                <InputOTPSlot index={1} className={otpSlotClassName} />
                <InputOTPSlot index={2} className={otpSlotClassName} />
              </InputOTPGroup>
              <div role="separator" className="text-white/50">
                <DotIcon />
              </div>
              <InputOTPGroup>
                <InputOTPSlot index={3} className={otpSlotClassName} />
                <InputOTPSlot index={4} className={otpSlotClassName} />
                <InputOTPSlot index={5} className={otpSlotClassName} />
              </InputOTPGroup>
            </InputOTP>
          </div>
        ) : null}

        {model.errorMessage ? <div className="text-sm text-yellow-200">{model.errorMessage}</div> : null}

        <Button
          onClick={model.onConfirmRead}
          disabled={consuming || (model.requiresPassword && model.accessPassword.length < 6)}
          style={{ backgroundColor: "var(--retypeset-highlight)", color: "var(--retypeset-primary)" }}
          className="w-full border-0 font-semibold shadow-none transition hover:brightness-95"
        >
          {consuming ? "正在打开..." : "确认阅读"}
        </Button>
      </TiltCard>
    </BurnShell>
  )
}
