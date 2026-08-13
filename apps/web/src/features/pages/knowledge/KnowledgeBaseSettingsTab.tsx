"use client"

import * as React from "react"
import { ExternalLink, Loader2, Play, X } from "lucide-react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ChunkPreviewDialog } from "@/features/pages/knowledge/chunking/ChunkPreviewDialog"
import { COMMON_SEPARATORS, addSeparator, removeSeparator, separatorLabel } from "@/features/pages/knowledge/chunking/separators"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  aiModelConfigApi,
  knowledgeBaseApi,
  type AiConfigType,
  type AiModelConfigResponse,
  type KnowledgeBaseChunkStrategy,
  type KnowledgeBaseResponse,
} from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"

function errorMessage(error: unknown, fallback: string) {
  return (error as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
    (error instanceof Error ? error.message : fallback)
}

function ModelSelect({
  label,
  value,
  models,
  onChange,
}: {
  label: string
  value: string | null
  models: AiModelConfigResponse[]
  onChange: (value: string | null) => void
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value ?? "default"} onValueChange={(next) => onChange(next === "default" ? null : next)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="default">使用全局默认模型</SelectItem>
          {models.map((model) => <SelectItem key={model.id} value={model.id}>{model.name} · {model.model}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

export function KnowledgeBaseSettingsTab({ knowledgeBase, onSaved }: { knowledgeBase: KnowledgeBaseResponse; onSaved: () => Promise<void> }) {
  const [name, setName] = React.useState(knowledgeBase.name)
  const [description, setDescription] = React.useState(knowledgeBase.description)
  const [strategy, setStrategy] = React.useState<KnowledgeBaseChunkStrategy>(knowledgeBase.chunkStrategy)
  const [chunkSize, setChunkSize] = React.useState(clampChunkSize(knowledgeBase.chunkSize))
  const [overlap, setOverlap] = React.useState(Math.max(0, knowledgeBase.chunkOverlap))
  const [separators, setSeparators] = React.useState<string[]>(knowledgeBase.chunkSeparators)
  const [enableParentChild, setEnableParentChild] = React.useState(knowledgeBase.enableParentChild)
  const [parentChunkSize, setParentChunkSize] = React.useState(knowledgeBase.parentChunkSize || 4096)
  const [childChunkSize, setChildChunkSize] = React.useState(knowledgeBase.childChunkSize || 384)
  const [previewOpen, setPreviewOpen] = React.useState(false)
  const [chatModelId, setChatModelId] = React.useState<string | null>(knowledgeBase.chatModelId)
  const [embeddingModelId, setEmbeddingModelId] = React.useState<string | null>(knowledgeBase.embeddingModelId)
  const [rerankModelId, setRerankModelId] = React.useState<string | null>(knowledgeBase.rerankModelId)
  const [wikiEnabled, setWikiEnabled] = React.useState(knowledgeBase.wikiEnabled)
  const [models, setModels] = React.useState<Record<"CHAT" | "EMBEDDING" | "RERANK", AiModelConfigResponse[]>>({ CHAT: [], EMBEDDING: [], RERANK: [] })
  const [saving, setSaving] = React.useState(false)
  const [loadingModels, setLoadingModels] = React.useState(true)
  // 重叠必须小于分块大小，否则切片会原地打转；上限跟随分块大小的一半浮动。
  const overlapMax = Math.min(OVERLAP_MAX, Math.floor(chunkSize / 2))

  React.useEffect(() => {
    let cancelled = false
    const types: Array<"CHAT" | "EMBEDDING" | "RERANK"> = ["CHAT", "EMBEDDING", "RERANK"]
    Promise.all(types.map(async (configType) => {
      const response = await aiModelConfigApi.list({ configType: configType as AiConfigType, pageSize: 100, enabled: true })
      return [configType, response.data.rows] as const
    })).then((entries) => {
      if (cancelled) return
      setModels(Object.fromEntries(entries) as typeof models)
    }).catch((error) => {
      if (!cancelled) toast.error(errorMessage(error, "加载模型列表失败"))
    }).finally(() => {
      if (!cancelled) setLoadingModels(false)
    })
    return () => { cancelled = true }
  }, [])

  const save = React.useCallback(async () => {
    setSaving(true)
    try {
      await knowledgeBaseApi.update({
        knowledgeBaseId: knowledgeBase.id,
        name: name.trim(),
        description: description.trim() || null,
        chunkStrategy: strategy,
        chunkSize,
        chunkOverlap: Math.min(overlap, overlapMax),
        chunkSeparators: separators,
        enableParentChild,
        parentChunkSize: enableParentChild ? parentChunkSize : 0,
        childChunkSize: enableParentChild ? childChunkSize : 0,
        chatModelId,
        embeddingModelId,
        rerankModelId,
        wikiEnabled,
      })
      toast.success("知识库设置已保存")
      await onSaved()
    } catch (error) {
      toast.error(errorMessage(error, "保存设置失败"))
    } finally {
      setSaving(false)
    }
  }, [chatModelId, childChunkSize, chunkSize, description, embeddingModelId, enableParentChild, knowledgeBase.id, name, onSaved, overlap, overlapMax, parentChunkSize, rerankModelId, separators, strategy, wikiEnabled])

  return (
    <div className="grid gap-4 pb-8 xl:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>基本信息</CardTitle><CardDescription>知识库的名称与用途说明。</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label htmlFor="kb-name">名称</Label><Input id="kb-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="kb-description">描述</Label><Textarea id="kb-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={4} /></div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div><p className="text-sm font-medium">自动 Wiki</p><p className="text-xs text-muted-foreground">上传解析后可从文件生成结构化 Wiki 页面与双链。</p></div>
            <Switch checked={wikiEnabled} onCheckedChange={setWikiEnabled} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div><CardTitle>分块设置</CardTitle><CardDescription>控制上传文档在嵌入前的切分方式。默认值适用于大多数场景，仅在检索质量异常时调整。</CardDescription></div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => setPreviewOpen(true)}><Play className="size-3.5" />测试分块效果</Button>
        </CardHeader>
        <CardContent className="space-y-5">
          <SettingRow label="分块策略" hint="选择文档的分块方式。自动模式会分析每个文档的结构并选择最佳策略。">
            <Select value={strategy} onValueChange={(value) => setStrategy(value as KnowledgeBaseChunkStrategy)}>
              <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">自动结构识别（推荐）</SelectItem>
                <SelectItem value="heading">Markdown 标题层级</SelectItem>
                <SelectItem value="heuristic">章节边界识别</SelectItem>
                <SelectItem value="recursive">递归语义切片</SelectItem>
                <SelectItem value="paragraph">段落切片</SelectItem>
                <SelectItem value="fixed">固定长度</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow
            label="分块大小"
            hint={`每个分块的最大字符数（${CHUNK_SIZE_MIN}-${CHUNK_SIZE_MAX}）。默认 512 ≈ 中文 300 tokens / 英文 100-130 tokens。FAQ 用 200-400，叙述性长文档用 1000-2000。`}
          >
            <RangeField
              id="chunk-size"
              min={CHUNK_SIZE_MIN}
              max={CHUNK_SIZE_MAX}
              step={4}
              value={chunkSize}
              ticks={[100, 1000, 2000, 4000]}
              unit="字符"
              onChange={setChunkSize}
            />
          </SettingRow>

          <SettingRow
            label="分块重叠"
            hint={`相邻分块之间共享的字符数（0-${overlapMax}）。默认 80 ≈ 分块大小的 15%。FAQ/结构化数据用 0，长篇叙述用 150-200。`}
          >
            <RangeField
              id="chunk-overlap"
              min={0}
              max={overlapMax}
              step={5}
              value={Math.min(overlap, overlapMax)}
              ticks={[0, Math.round(overlapMax / 2), overlapMax]}
              unit="字符"
              onChange={setOverlap}
            />
          </SettingRow>

          <SettingRow label="分隔符" hint="切分时优先使用的字符或字符串。排在前面的分隔符先尝试；默认顺序优先段落 → 句子 → 标点。">
            <SeparatorEditor value={separators} onChange={setSeparators} />
          </SettingRow>

          <SettingRow
            label="父子分块"
            hint="两级分块：小的子块用于向量匹配（精准命中），大的父块在命中后回填给模型（上下文更完整）。建议用于长文档；短 FAQ 可关闭以节省存储。"
          >
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Switch checked={enableParentChild} onCheckedChange={setEnableParentChild} />
                <span className="text-sm text-muted-foreground">{enableParentChild ? "已开启" : "已关闭"}</span>
              </div>
              {enableParentChild ? (
                <div className="space-y-3 rounded-md border p-3">
                  <RangeField id="parent-chunk-size" min={512} max={8192} step={128} value={parentChunkSize}
                    ticks={[512, 4096, 8192]} unit="字符" onChange={setParentChunkSize} />
                  <p className="text-[11px] text-muted-foreground">父块大小，默认 4096。命中后回填给模型的就是这一段。</p>
                  <RangeField id="child-chunk-size" min={100} max={1024} step={16} value={childChunkSize}
                    ticks={[100, 384, 1024]} unit="字符" onChange={setChildChunkSize} />
                  <p className="text-[11px] text-muted-foreground">子块大小，默认 384，重叠固定为其 1/5。只有子块参与向量化。</p>
                </div>
              ) : null}
            </div>
          </SettingRow>
        </CardContent>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader className="flex-row items-start justify-between gap-4"><div><CardTitle>检索与生成模型</CardTitle><CardDescription>知识库可以覆盖全局默认的 Chat、Embedding 和 Rerank 模型。</CardDescription></div><Button variant="outline" size="sm" asChild><Link to={dashboardRoutes.aiConfig}>模型中心<ExternalLink className="size-3.5" /></Link></Button></CardHeader>
        <CardContent>
          {loadingModels ? <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />加载模型…</div> : <div className="grid gap-4 md:grid-cols-3"><ModelSelect label="对话模型" value={chatModelId} models={models.CHAT} onChange={setChatModelId} /><ModelSelect label="Embedding 模型" value={embeddingModelId} models={models.EMBEDDING} onChange={setEmbeddingModelId} /><ModelSelect label="Rerank 模型" value={rerankModelId} models={models.RERANK} onChange={setRerankModelId} /></div>}
        </CardContent>
      </Card>

      <div className="flex justify-end xl:col-span-2"><Button disabled={saving || !name.trim()} onClick={() => void save()}>{saving ? <Loader2 className="size-4 animate-spin" /> : null}保存设置</Button></div>

      <ChunkPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        knowledgeBaseId={knowledgeBase.id}
        options={{
          strategy, chunkSize, chunkOverlap: Math.min(overlap, overlapMax), separators,
          enableParentChild,
          parentChunkSize: enableParentChild ? parentChunkSize : 0,
          childChunkSize: enableParentChild ? childChunkSize : 0,
        }}
      />
    </div>
  )
}

const CHUNK_SIZE_MIN = 100
const CHUNK_SIZE_MAX = 4000
const OVERLAP_MAX = 500

function clampChunkSize(value: number) {
  return Math.min(CHUNK_SIZE_MAX, Math.max(CHUNK_SIZE_MIN, Math.round(value)))
}

/** 左侧标题 + 说明，右侧控件的两栏布局，让每项设置都带上使用建议。 */
function SettingRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 border-b pb-5 last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:gap-6">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** 滑块 + 数值读数 + 刻度标签，比裸数字输入框更容易判断当前值处于什么量级。 */
function RangeField({
  id, min, max, step, value, ticks, unit, onChange,
}: {
  id: string
  min: number
  max: number
  step: number
  value: number
  ticks: number[]
  unit: string
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        />
        <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">{value} {unit}</span>
      </div>
      <div className="mt-1.5 flex justify-between pr-27 text-[11px] tabular-nums text-muted-foreground">
        {ticks.map((tick) => <span key={tick}>{tick}</span>)}
      </div>
    </div>
  )
}

/** 分隔符以标签形式增删，并提供常用项快捷添加，避免手写转义字符。 */
function SeparatorEditor({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [draft, setDraft] = React.useState("")
  const remaining = COMMON_SEPARATORS.filter((item) => !value.includes(item.value))

  const commitDraft = () => {
    const next = addSeparator(value, draft)
    if (next !== value) onChange(next)
    setDraft("")
  }

  return (
    <div className="space-y-2">
      <div className="flex min-h-9 flex-wrap gap-1.5 rounded-md border p-1.5">
        {value.length === 0 ? <span className="px-1 py-0.5 text-xs text-muted-foreground">未设置，按长度切分</span> : null}
        {value.map((item) => (
          <Badge key={item} variant="secondary" className="gap-1 font-normal">
            {separatorLabel(item)}
            <button type="button" aria-label={`移除 ${separatorLabel(item)}`} className="text-muted-foreground hover:text-foreground" onClick={() => onChange(removeSeparator(value, item))}>
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            commitDraft()
          }}
          placeholder="自定义分隔符，支持 \n \t"
          className="h-8 flex-1 text-xs"
        />
        <Button variant="outline" size="sm" className="h-8" disabled={!draft.trim()} onClick={commitDraft}>添加</Button>
      </div>
      {remaining.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {remaining.map((item) => (
            <button
              key={item.value}
              type="button"
              className="rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-solid hover:text-foreground"
              onClick={() => onChange(addSeparator(value, item.value))}
            >
              + {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
