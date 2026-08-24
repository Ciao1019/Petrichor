"use client"

import * as React from "react"

import { FileText, Sparkles } from "@/components/iconimate"
import { AnimatedTabs } from "@/components/microinteractions/animated-tabs"
import { SegmentedControl } from "@/components/godui/segmented-control"

function kbOptions(name: string) {
  return [
    {
      value: "documents",
      label: (
        <span className="flex items-center gap-2">
          <FileText className="size-4 shrink-0 opacity-70" />
          {name}
        </span>
      ),
    },
    {
      value: "knowledge",
      label: (
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 shrink-0 opacity-70" />
          知识空间
        </span>
      ),
    },
  ]
}

/** 知识库页面里的真实用法：只留图标，文案交给 tooltip。 */
function iconOnlyOptions(name: string) {
  return [
    {
      value: "documents",
      ariaLabel: name,
      label: <FileText className="size-[18px] shrink-0" />,
    },
    {
      value: "knowledge",
      ariaLabel: "知识空间",
      label: <Sparkles className="size-[18px] shrink-0" />,
    },
  ]
}

function Row({ name, width }: { name: string; width: number }) {
  const [view, setView] = React.useState("documents")
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground">容器 {width}px</p>
      <div className="min-w-0 border border-dashed border-red-400/40" style={{ width }}>
        <SegmentedControl
          value={view}
          onValueChange={setView}
          options={kbOptions(name)}
          size="lg"
          className="-ml-3"
        />
      </div>
    </div>
  )
}

function TabsRow({
  name,
  width,
  iconOnly,
}: {
  name: string
  width: number
  iconOnly?: boolean
}) {
  const [view, setView] = React.useState("documents")
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground">
        容器 {width}px{iconOnly ? " · 纯图标" : ""}
      </p>
      <div className="min-w-0 border border-dashed border-red-400/40" style={{ width }}>
        <AnimatedTabs
          value={view}
          onValueChange={setView}
          options={iconOnly ? iconOnlyOptions(name) : kbOptions(name)}
          size="lg"
          className="-translate-x-3"
        />
      </div>
    </div>
  )
}

export default function SegmentedPreviewPage() {
  if (typeof document !== "undefined") document.documentElement.classList.remove("dark")
  return (
    <div className="dark space-y-8 bg-background p-6 text-foreground">
      <section className="space-y-5">
        <h2 className="text-xs text-muted-foreground">SegmentedControl（旧）</h2>
        <Row name="我的文档" width={420} />
        <Row name="我的文档" width={240} />
        <Row name="产品设计知识库归档 2026" width={300} />
      </section>
      <section className="space-y-5">
        <h2 className="text-xs text-muted-foreground">AnimatedTabs（弹簧指示条）</h2>
        <TabsRow name="我的文档" width={420} iconOnly />
        <TabsRow name="我的文档" width={420} />
        <TabsRow name="我的文档" width={240} />
        <TabsRow name="产品设计知识库归档 2026" width={300} />
      </section>
    </div>
  )
}
