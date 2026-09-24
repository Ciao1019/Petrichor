"use client"

import * as React from "react"
import { MessageCircleQuestion } from "@/components/iconimate"

import { RetypesetSiteFooter, RetypesetSiteHeader, RetypesetSiteNav } from "@/features/pages/blog/RetypesetSiteChrome"
import { publicSiteAppearanceApi } from "@/lib/api"
import { PublicQaChat } from "./PublicQaChat"

type Availability = "loading" | "enabled" | "disabled" | "error"

export function PublicQaPage() {
  const [availability, setAvailability] = React.useState<Availability>("loading")

  React.useEffect(() => {
    let canceled = false
    publicSiteAppearanceApi
      .detail()
      .then((res) => {
        if (canceled) return
        setAvailability(res.data.publicQaEnabled ? "enabled" : "disabled")
      })
      .catch(() => {
        if (!canceled) setAvailability("error")
      })
    return () => {
      canceled = true
    }
  }, [])

  return (
    <main className="retypeset-home scrollbar-hide relative flex h-[100dvh] min-h-0 flex-col overflow-hidden bg-[#0044cc] text-white selection:bg-yellow-300 selection:text-blue-950">
      <div className="blog-home-grid pointer-events-none fixed inset-0 z-0" />

      <div className="relative z-30 mx-auto w-full max-w-[51.462rem] px-[min(7.25vw,3.731rem)] pt-8 lg:contents">
        <RetypesetSiteHeader dockVisible />
        <RetypesetSiteNav activeSection="ask" dockVisible />
      </div>

      {/* 与文章页一致：桌面端内部 fixed 对话大纲需高于 z-30 侧栏，短视口下两者会重叠。 */}
      <section className="relative z-20 mx-auto flex w-full min-h-0 max-w-[51.462rem] flex-1 flex-col px-[min(7.25vw,3.731rem)] py-6 lg:z-40 lg:mx-[max(5.75rem,calc(50vw-34.25rem))] lg:max-w-[min(calc(75vw-16rem),44rem)] lg:px-0 lg:py-10">
        {availability === "loading" ? null : availability === "enabled" ? (
          <PublicQaChat />
        ) : availability === "disabled" ? (
          <CenteredHint
            icon={<MessageCircleQuestion className="size-7" />}
            title="问答功能暂未开启"
            text="站长尚未开启前台公开问答，请稍后再来或浏览文章。"
          />
        ) : (
          <CenteredHint
            icon={<MessageCircleQuestion className="size-7" />}
            title="加载失败"
            text="无法获取问答配置，请刷新页面重试。"
          />
        )}
      </section>

      <RetypesetSiteFooter />
    </main>
  )
}

function CenteredHint({
  icon,
  title,
  text,
}: {
  icon?: React.ReactNode
  title?: string
  text: string
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      {icon ? <div className="text-yellow-300">{icon}</div> : null}
      {title ? <p className="text-base font-medium text-white">{title}</p> : null}
      <p className="max-w-sm text-sm text-white/70">{text}</p>
    </div>
  )
}
