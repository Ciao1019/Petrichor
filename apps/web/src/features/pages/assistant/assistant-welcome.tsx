import * as React from "react"
import { gsap } from "@/lib/gsap"
import { cn } from "@/lib/utils"

export function AssistantWelcomeComposer({
  isEmpty,
  scopeName,
  children,
}: {
  isEmpty: boolean
  scopeName: string | null
  children: React.ReactNode
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const composerRef = React.useRef<HTMLDivElement>(null)

  React.useLayoutEffect(() => {
    const root = rootRef.current
    const composer = composerRef.current
    if (!root || !composer) return
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    let context: gsap.Context | undefined
    const animate = () => {
      context?.revert()
      if (media.matches) return
      context = gsap.context(() => {
        if (isEmpty) {
          // 新对话中输入框先回到中央，欢迎语随后出现。
          gsap.fromTo(composer, { y: 48, opacity: 0 }, {
            y: 0, opacity: 1, duration: 0.42, ease: "power3.out", clearProps: "transform,opacity",
          })
          gsap.fromTo("[data-welcome-intro]", { y: 10, opacity: 0 }, {
            y: 0, opacity: 1, duration: 0.36, delay: 0.08, clearProps: "transform,opacity",
          })
        } else {
          gsap.fromTo(composer, { y: 10, opacity: 0.7 }, {
            y: 0, opacity: 1, duration: 0.24, clearProps: "transform,opacity",
          })
        }
      }, root)
    }
    animate()
    media.addEventListener("change", animate)
    return () => {
      media.removeEventListener("change", animate)
      context?.revert()
    }
  }, [isEmpty])

  return (
    <div ref={rootRef} className={cn("w-full shrink-0", isEmpty && "my-auto py-6 md:py-10")}>
      {isEmpty ? (
        <div data-welcome-intro className="mx-auto mb-6 max-w-xl px-3 text-center md:mb-8">
          <h1 className="text-xl font-semibold tracking-tight text-foreground md:text-2xl">今天想了解些什么？</h1>
          <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">
            {scopeName ? `从「${scopeName}」开始，聊聊你的问题。` : "从一个问题开始，让知识库和文档里的线索连起来。"}
          </p>
        </div>
      ) : null}
      {/* 保持同一个输入框实例，发送首条消息时保留焦点、输入法和附件状态。 */}
      <div ref={composerRef}>{children}</div>
    </div>
  )
}
