"use client"

import * as React from "react"

import { FileText, Sparkles } from "@/components/iconimate"
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

export default function SegmentedPreviewPage() {
  if (typeof document !== "undefined") document.documentElement.classList.remove("dark")
  return (
    <div className="dark space-y-5 bg-background p-6 text-foreground">
      <Row name="我的文档" width={420} />
      <Row name="我的文档" width={240} />
      <Row name="产品设计知识库归档 2026" width={300} />
    </div>
  )
}
