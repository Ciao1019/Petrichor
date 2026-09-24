import * as React from "react"
import { ArrowRight, FileText, Link2, Loader2, Sparkles } from "@/components/iconimate"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import type { CaptureConfig, CaptureOptions } from "@/lib/api-capture"
import { cn } from "@/lib/utils"

interface Props {
  urls: string
  options: CaptureOptions
  config: CaptureConfig
  busy: boolean
  onURLs: (value: string) => void
  onOptions: (options: CaptureOptions) => void
  onSubmit: () => void
}

export function CaptureInput({ urls, options, config, busy, onURLs, onOptions, onSubmit }: Props) {
  const hintId = React.useId()
  const ai = options.engine !== "none"
  const aiReady = config.modelReady || config.aiFormats
  const count = new Set(urls.trim().split(/\s+/).filter(Boolean)).size
  const remaining = Math.max(0, config.dailyLimit - config.used)
  const unavailable = !config.enabled || remaining === 0 || (ai && !aiReady)
  const canSubmit = !busy && !unavailable && count > 0
  // 阻断提交的原因用 status 播报；其余只是一行弱提示，避免多段说明文字堆叠。
  const blocker = !config.enabled ? "网页采集暂未启用，请联系管理员开启。"
    : remaining === 0 ? "今日采集额度已用完，已有内容仍可查看和保存。"
    : ai && !aiReady ? "AI 整理暂不可用，可以先收藏原文。"
    : ""
  const hint = [
    count > 1 ? `${count} 个网址，每篇单独保存` : ai ? "生成摘要与要点，同时保留原文" : "保留完整正文与来源",
    !aiReady && !ai ? "配置对话模型后可用 AI 整理" : "",
    remaining <= 5 ? `今日还可采集 ${remaining} 篇` : "",
  ].filter(Boolean).join(" · ")

  return (
    <form className="space-y-3 p-3 sm:p-4" onSubmit={(event) => { event.preventDefault(); if (canSubmit) onSubmit() }}>
      <div className="flex items-start gap-2.5 rounded-xl border border-border/70 bg-background px-3 py-2.5 transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/15">
        <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <label htmlFor="capture-urls" className="sr-only">网页地址，每行一个</label>
        <Textarea
          id="capture-urls"
          value={urls}
          onChange={(event) => onURLs(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && canSubmit) {
              event.preventDefault()
              onSubmit()
            }
          }}
          placeholder="粘贴文章链接，多个链接用换行分隔"
          rows={1}
          maxLength={config.maxBatch * 4100}
          disabled={busy || !config.enabled}
          aria-describedby={hintId}
          className="max-h-40 min-h-5 min-w-0 flex-1 resize-none rounded-none border-0 bg-transparent! p-0 leading-5 shadow-none placeholder:text-muted-foreground/80 focus-visible:ring-0"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="inline-flex items-center rounded-lg bg-muted/60 p-0.5" aria-label="保存方式">
          {[
            { value: false, label: "收藏原文", Icon: FileText, title: "保留完整正文和来源，不调用 AI；消耗网页采集用量" },
            { value: true, label: "AI 整理", Icon: Sparkles, title: aiReady ? "生成摘要与要点；消耗采集与模型用量" : "配置对话模型后可用" },
          ].map(({ value, label, Icon, title }) => (
            <button key={label} type="button" title={title} aria-pressed={ai === value} disabled={busy || (value && !aiReady)}
              onClick={() => onOptions({ ...options, engine: value ? (config.modelReady ? "model" : "firecrawl") : "none" })}
              className={cn("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50", ai === value ? "bg-card font-medium text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="size-3.5" />{label}
            </button>
          ))}
        </div>
        {blocker
          ? <p id={hintId} role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">{blocker}</p>
          : <p id={hintId} className="min-w-0 flex-1 truncate text-xs text-muted-foreground/80">{hint}</p>}
        <Button type="submit" size="sm" disabled={!canSubmit} className="ml-auto h-8 gap-1.5 rounded-lg px-3 text-xs font-medium">
          {busy ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : null}
          {busy ? "正在提交" : ai ? "采集并整理" : "采集网页"}
          {!busy && <ArrowRight className="size-3.5" />}
        </Button>
      </div>
    </form>
  )
}
