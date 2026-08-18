"use client"

import * as React from "react"
import { ChevronDown, ChevronUp, Loader2, Package, Plus, RefreshCw, Save, Trash2 } from "@/components/iconimate"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  adminProjectShowcaseApi,
  publicProjectShowcaseApi,
  type ProjectItem,
  type ProjectShowcaseResponse,
  type ProjectStampColor,
} from "@/lib/api"

type FormItem = Omit<ProjectItem, "stack"> & { stackText: string }

const STAMP_COLOR_OPTIONS: { value: ProjectStampColor; label: string; swatch: string }[] = [
  { value: "red", label: "红色", swatch: "var(--desk-marker-red)" },
  { value: "orange", label: "橙色", swatch: "var(--desk-marker-orange)" },
  { value: "green", label: "绿色", swatch: "var(--desk-marker-green)" },
  { value: "teal", label: "青色", swatch: "var(--desk-marker-teal)" },
  { value: "blue", label: "蓝色", swatch: "var(--desk-marker-blue)" },
  { value: "purple", label: "紫色", swatch: "var(--desk-marker-purple)" },
  { value: "pink", label: "粉色", swatch: "var(--desk-marker-pink)" },
]

function resolveApiError(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : "") ||
    fallback
  )
}

function toFormItem(item: ProjectItem): FormItem {
  const { stack, ...rest } = item
  return { ...rest, stackText: stack.join(", ") }
}

function splitStack(text: string): string[] {
  const seen = new Set<string>()
  const values: string[] = []
  for (const part of text.split(/[,，\n]/)) {
    const value = part.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    values.push(value)
  }
  return values
}

function emptyItem(): FormItem {
  return { name: "", year: "", stackText: "", stamp: "", stampColor: "red", blurb: "", repoUrl: "", siteUrl: "" }
}

function formatDateTime(value?: string | null) {
  if (!value) return "尚未写入数据库"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function ProjectsConfigPage() {
  const [heading, setHeading] = React.useState("开源项目")
  const [intro, setIntro] = React.useState("")
  const [items, setItems] = React.useState<FormItem[]>([])
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  const applyShowcase = React.useCallback((data: ProjectShowcaseResponse) => {
    setHeading(data.heading)
    setIntro(data.intro)
    setItems(data.items.map(toFormItem))
    setUpdatedAt(data.updatedAt ?? null)
  }, [])

  const updateItem = React.useCallback((index: number, patch: Partial<FormItem>) => {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }, [])

  const addItem = React.useCallback(() => {
    setItems((current) => [...current, emptyItem()])
  }, [])

  const removeItem = React.useCallback((index: number) => {
    setItems((current) => current.filter((_, i) => i !== index))
  }, [])

  const moveItem = React.useCallback((index: number, direction: -1 | 1) => {
    setItems((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const next = [...current]
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }, [])

  const fetchShowcase = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminProjectShowcaseApi.detail()
      applyShowcase(res.data)
    } catch (e: unknown) {
      toast.error(resolveApiError(e, "加载开源项目配置失败"))
    } finally {
      setLoading(false)
    }
  }, [applyShowcase])

  React.useEffect(() => {
    void fetchShowcase()
  }, [fetchShowcase])

  const handleSave = React.useCallback(async () => {
    if (!heading.trim()) {
      toast.error("请输入标题")
      return
    }
    const payloadItems: ProjectItem[] = items
      .map((item) => ({
        name: item.name.trim(),
        year: item.year.trim(),
        stack: splitStack(item.stackText),
        stamp: item.stamp.trim(),
        stampColor: item.stampColor,
        blurb: item.blurb.trim(),
        repoUrl: item.repoUrl.trim(),
        siteUrl: item.siteUrl.trim(),
      }))
      .filter((item) => item.name.length > 0)

    setSaving(true)
    try {
      const res = await adminProjectShowcaseApi.update({ heading, intro, items: payloadItems })
      applyShowcase(res.data)
      publicProjectShowcaseApi.invalidateClientCache()
      toast.success("开源项目配置已保存")
    } catch (e: unknown) {
      toast.error(resolveApiError(e, "保存开源项目配置失败"))
    } finally {
      setSaving(false)
    }
  }, [applyShowcase, heading, intro, items])

  return (
    <div className="flex w-full flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Package className="size-6 text-primary" />
            开源项目
          </h1>
          <p className="text-sm text-muted-foreground">
            维护公开 `/projects` 页的项目清单（手写桌面风）。该配置为站点单例，仅超级管理员可编辑。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={() => void fetchShowcase()} disabled={loading || saving}>
            {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
            刷新
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={loading || saving}>
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            保存
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader>
            <CardTitle>页头</CardTitle>
            <CardDescription>标题与副标题展示在 `/projects` 纸面清单顶部。副标题留空即隐藏。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="projects-heading">标题</Label>
              <Input
                id="projects-heading"
                value={heading}
                disabled={loading}
                onChange={(event) => setHeading(event.target.value)}
                placeholder="开源项目"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="projects-intro">副标题（可空）</Label>
              <Input
                id="projects-intro"
                value={intro}
                disabled={loading}
                onChange={(event) => setIntro(event.target.value)}
                placeholder="一些我做过、正在做的东西。"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>发布状态</CardTitle>
            <CardDescription>公开页面读取当前单例配置。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">更新时间</span>
              <span className="text-right">{formatDateTime(updatedAt)}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">项目数量</span>
              <span className="text-right">{items.length}</span>
            </div>
            <Button type="button" variant="outline" className="w-full" asChild>
              <a href="/projects" target="_blank" rel="noopener noreferrer">
                预览公开页面
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>项目列表</CardTitle>
          <CardDescription>
            按此处顺序在前台从上到下展示，用「上移 / 下移」调整。技术栈用逗号分隔；「标签词」是项目名右侧那圈手绘马克笔圈词（如 popular / new / WIP），留空则不画圈；描述、链接均可留空。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无项目，点击下方「添加项目」。</p>
          ) : (
            items.map((item, index) => (
              <div key={index} className="space-y-4 rounded-lg border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-muted-foreground">#{index + 1}</span>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={loading || index === 0}
                      onClick={() => moveItem(index, -1)}
                      aria-label="上移"
                    >
                      <ChevronUp className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={loading || index === items.length - 1}
                      onClick={() => moveItem(index, 1)}
                      aria-label="下移"
                    >
                      <ChevronDown className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={loading}
                      onClick={() => removeItem(index)}
                      aria-label="删除该项目"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_140px]">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">项目名称</Label>
                    <Input
                      value={item.name}
                      disabled={loading}
                      onChange={(event) => updateItem(index, { name: event.target.value })}
                      placeholder="Ech0 — self-hosted microblog"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">年份</Label>
                    <Input
                      value={item.year}
                      disabled={loading}
                      onChange={(event) => updateItem(index, { year: event.target.value })}
                      placeholder="2025"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">技术栈（逗号分隔）</Label>
                  <Input
                    value={item.stackText}
                    disabled={loading}
                    onChange={(event) => updateItem(index, { stackText: event.target.value })}
                    placeholder="Go, Vue"
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_160px]">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">标签词（可空，如 popular）</Label>
                    <Input
                      value={item.stamp}
                      disabled={loading}
                      onChange={(event) => updateItem(index, { stamp: event.target.value })}
                      placeholder="popular"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">圈词颜色</Label>
                    <Select
                      value={item.stampColor}
                      disabled={loading}
                      onValueChange={(value) => updateItem(index, { stampColor: value as ProjectStampColor })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STAMP_COLOR_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            <span className="flex items-center gap-2">
                              <span
                                className="inline-block size-3 shrink-0 rounded-full"
                                style={{ background: option.swatch }}
                                aria-hidden="true"
                              />
                              {option.label}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">描述（可空，点开展开时显示）</Label>
                  <Textarea
                    value={item.blurb}
                    disabled={loading}
                    onChange={(event) => updateItem(index, { blurb: event.target.value })}
                    rows={3}
                    placeholder="An open-source, self-hosted space for publishing and sharing your thoughts."
                  />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">GitHub 链接（可空）</Label>
                    <Input
                      value={item.repoUrl}
                      disabled={loading}
                      onChange={(event) => updateItem(index, { repoUrl: event.target.value })}
                      placeholder="https://github.com/you/project"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">官网链接（可空）</Label>
                    <Input
                      value={item.siteUrl}
                      disabled={loading}
                      onChange={(event) => updateItem(index, { siteUrl: event.target.value })}
                      placeholder="https://example.com"
                    />
                  </div>
                </div>
              </div>
            ))
          )}
          <Button type="button" variant="outline" size="sm" disabled={loading} onClick={addItem}>
            <Plus className="mr-2 size-4" />
            添加项目
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
