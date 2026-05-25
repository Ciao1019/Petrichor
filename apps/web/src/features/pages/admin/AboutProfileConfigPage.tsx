"use client"

import * as React from "react"
import { Eye, Loader2, RefreshCw, Save } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { adminAboutProfileApi, type AboutProfileResponse } from "@/lib/api"

const emptyProfile: AboutProfileResponse = {
  displayName: "",
  roleTitle: "",
  intro: "",
  expertise: [],
  toolkit: [],
  quote: "",
}

function resolveApiError(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : "") ||
    fallback
  )
}

function linesToText(values: string[]) {
  return values.join("\n")
}

function textToLines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function formatDateTime(value?: string | null) {
  if (!value) return "尚未写入数据库"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function AboutProfileConfigPage() {
  const [profile, setProfile] = React.useState<AboutProfileResponse>(emptyProfile)
  const [expertiseLines, setExpertiseLines] = React.useState("")
  const [toolkitLines, setToolkitLines] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  const applyProfile = React.useCallback((nextProfile: AboutProfileResponse) => {
    setProfile(nextProfile)
    setExpertiseLines(linesToText(nextProfile.expertise))
    setToolkitLines(linesToText(nextProfile.toolkit))
  }, [])

  const fetchProfile = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAboutProfileApi.detail()
      applyProfile(res.data)
    } catch (e: unknown) {
      toast.error(resolveApiError(e, "加载关于我配置失败"))
    } finally {
      setLoading(false)
    }
  }, [applyProfile])

  React.useEffect(() => {
    void fetchProfile()
  }, [fetchProfile])

  const handleSave = React.useCallback(async () => {
    const expertise = textToLines(expertiseLines)
    const toolkit = textToLines(toolkitLines)
    if (!profile.displayName.trim()) {
      toast.error("请输入名称")
      return
    }
    if (!profile.roleTitle.trim()) {
      toast.error("请输入副标题")
      return
    }
    if (!profile.intro.trim()) {
      toast.error("请输入自我介绍")
      return
    }
    if (expertise.length === 0) {
      toast.error("请至少填写一项 Expertise")
      return
    }
    if (toolkit.length === 0) {
      toast.error("请至少填写一项 Toolkit")
      return
    }
    if (!profile.quote.trim()) {
      toast.error("请输入 quote")
      return
    }

    setSaving(true)
    try {
      const res = await adminAboutProfileApi.update({
        displayName: profile.displayName,
        roleTitle: profile.roleTitle,
        intro: profile.intro,
        expertise,
        toolkit,
        quote: profile.quote,
      })
      applyProfile(res.data)
      toast.success("关于我配置已保存")
    } catch (e: unknown) {
      toast.error(resolveApiError(e, "保存关于我配置失败"))
    } finally {
      setSaving(false)
    }
  }, [applyProfile, expertiseLines, profile, toolkitLines])

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Eye className="size-6 text-primary" />
            关于我配置
          </h1>
          <p className="text-sm text-muted-foreground">
            维护公开关于页展示内容。该配置为站点单例，仅超级管理员可编辑。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={() => void fetchProfile()} disabled={loading || saving}>
            {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
            刷新
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={loading || saving}>
            {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            保存
          </Button>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardTitle>页面内容</CardTitle>
            <CardDescription>
              名称、副标题、自我介绍与 quote 会直接展示在 `/about` 页面。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="about-display-name">名称</Label>
                <Input
                  id="about-display-name"
                  value={profile.displayName}
                  disabled={loading}
                  onChange={(event) => setProfile((current) => ({ ...current, displayName: event.target.value }))}
                  placeholder="CiZai"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="about-role-title">副标题</Label>
                <Input
                  id="about-role-title"
                  value={profile.roleTitle}
                  disabled={loading}
                  onChange={(event) => setProfile((current) => ({ ...current, roleTitle: event.target.value }))}
                  placeholder="Creative Dev & Visual Artist"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="about-intro">自我介绍</Label>
              <Textarea
                id="about-intro"
                value={profile.intro}
                disabled={loading}
                onChange={(event) => setProfile((current) => ({ ...current, intro: event.target.value }))}
                rows={9}
                placeholder="每段之间留一个空行"
              />
              <p className="text-xs text-muted-foreground">前台会按空行拆分段落。</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="about-quote">Quote</Label>
              <Textarea
                id="about-quote"
                value={profile.quote}
                disabled={loading}
                onChange={(event) => setProfile((current) => ({ ...current, quote: event.target.value }))}
                rows={3}
                placeholder="Code is just another medium for painting dreams."
              />
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Expertise</CardTitle>
              <CardDescription>每行一项，保存时会过滤空行。</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={expertiseLines}
                disabled={loading}
                onChange={(event) => setExpertiseLines(event.target.value)}
                rows={8}
                placeholder="Frontend Architecture"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Toolkit</CardTitle>
              <CardDescription>每行一项，前台会渲染为标签。</CardDescription>
            </CardHeader>
            <CardContent>
              <Textarea
                value={toolkitLines}
                disabled={loading}
                onChange={(event) => setToolkitLines(event.target.value)}
                rows={8}
                placeholder="TypeScript"
              />
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
                <span className="text-right">{formatDateTime(profile.updatedAt)}</span>
              </div>
              <Button type="button" variant="outline" className="w-full" asChild>
                <a href="/about" target="_blank" rel="noopener noreferrer">
                  预览公开页面
                </a>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
