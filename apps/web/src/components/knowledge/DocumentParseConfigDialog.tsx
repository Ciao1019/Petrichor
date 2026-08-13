"use client"

/**
 * 上传前的「解析配置」弹窗：左侧分区导航 + 右侧配置面板。
 *
 * 这些配置只作用于本次上传（重新解析时沿用），不会改动知识库的默认设置；
 * 没有显式改动的项一律留空，由服务端回落到知识库默认值。
 */

import * as React from "react"
import { FileText, Image as ImageIcon, Loader2, MessageSquare, ScanText, Tag, X } from "lucide-react"

import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  type AiModelConfigResponse,
  type KBDocumentParseConfig,
  type KBParseEngine,
  type KnowledgeBaseChunkStrategy,
  type KnowledgeBaseResponse,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const MAX_QUESTION_INSTRUCTIONS = 4000
const MAX_QUESTIONS_PER_CHUNK = 10

type SectionKey = "tags" | "engine" | "chunking" | "image" | "question"

const ENGINE_LABEL: Record<KBParseEngine, string> = {
  auto: "默认",
  local: "仅本地抽取",
  scan: "按扫描件解析",
}

const STRATEGY_OPTIONS: Array<{ value: KnowledgeBaseChunkStrategy; label: string }> = [
  { value: "auto", label: "自动结构识别（推荐）" },
  { value: "heading", label: "Markdown 标题层级" },
  { value: "heuristic", label: "章节边界识别" },
  { value: "recursive", label: "递归语义切片" },
  { value: "paragraph", label: "段落切片" },
  { value: "fixed", label: "固定长度" },
]

/**
 * 生成一份「什么都没改」的配置：分块留空表示沿用知识库默认值。
 *
 * 图像处理默认开启，因为在「默认」解析引擎下它只对**没有文本层的页**生效：
 * 纯文字 PDF 一页都不会栅格化，也就一次模型都不调，开着不花钱；
 * 而默认关掉的话，扫描件会直接以「没有抽取到可用正文」失败。
 */
export function createDefaultParseConfig(): KBDocumentParseConfig {
  return {
    tags: [],
    parseEngine: "auto",
    chunking: {},
    multimodal: { enabled: true, modelConfigId: null },
    questionGeneration: { enabled: false, questionCount: 3, customInstructions: "" },
  }
}

export interface DocumentParseConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  knowledgeBase: KnowledgeBaseResponse
  /** 待上传的文件名，用于头部提示；重新解析时传单个已存在的文件名。 */
  fileNames: string[]
  /** 知识库里已用过的标签，供快速选择。 */
  availableTags: string[]
  visionModels: AiModelConfigResponse[]
  visionModelsLoading?: boolean
  value: KBDocumentParseConfig
  onChange: (next: KBDocumentParseConfig) => void
  onConfirm: () => void
  confirmLabel?: string
  busy?: boolean
}

export function DocumentParseConfigDialog({
  open,
  onOpenChange,
  knowledgeBase,
  fileNames,
  availableTags,
  visionModels,
  visionModelsLoading = false,
  value,
  onChange,
  onConfirm,
  confirmLabel = "确认上传并解析",
  busy = false,
}: DocumentParseConfigDialogProps) {
  const [section, setSection] = React.useState<SectionKey>("tags")
  const [tagDraft, setTagDraft] = React.useState("")

  const patch = React.useCallback(
    (next: Partial<KBDocumentParseConfig>) => onChange({ ...value, ...next }),
    [onChange, value]
  )
  const patchChunking = React.useCallback(
    (next: Partial<KBDocumentParseConfig["chunking"]>) => patch({ chunking: { ...value.chunking, ...next } }),
    [patch, value.chunking]
  )

  const tags = value.tags ?? []
  const chunkSize = value.chunking.chunkSize ?? knowledgeBase.chunkSize
  const chunkOverlap = value.chunking.chunkOverlap ?? knowledgeBase.chunkOverlap
  const strategy = value.chunking.strategy ?? knowledgeBase.chunkStrategy
  const parentChild = value.chunking.enableParentChild ?? knowledgeBase.enableParentChild
  const instructions = value.questionGeneration.customInstructions ?? ""

  const addTag = React.useCallback(
    (raw: string) => {
      const tag = raw.trim()
      if (!tag || tags.includes(tag)) return
      patch({ tags: [...tags, tag] })
      setTagDraft("")
    },
    [patch, tags]
  )

  const sections: Array<{ key: SectionKey; icon: React.ComponentType<{ className?: string }>; label: string; summary: string }> = [
    { key: "tags", icon: Tag, label: "文档标签", summary: tags.length > 0 ? `${tags.length} 个标签` : "未设置" },
    { key: "engine", icon: ScanText, label: "解析引擎", summary: ENGINE_LABEL[value.parseEngine] },
    { key: "chunking", icon: FileText, label: "分块设置", summary: `分块 ${chunkSize}${parentChild ? " · 父子" : ""}` },
    { key: "image", icon: ImageIcon, label: "图像处理", summary: value.multimodal.enabled ? "已开启" : "未开启" },
    {
      key: "question",
      icon: MessageSquare,
      label: "AI 问题生成",
      summary: value.questionGeneration.enabled ? `${value.questionGeneration.questionCount} 个` : "未开启",
    },
  ]

  const description =
    fileNames.length === 1
      ? fileNames[0]
      : fileNames.length > 1
        ? `${fileNames[0]} 等 ${fileNames.length} 个文件`
        : "未选择文件"

  return (
    <ModalShell
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        onOpenChange(next)
      }}
      disableClose={busy}
      title="解析配置"
      description={`${description} · 配置只作用于本次解析，不会改动知识库默认设置`}
      contentClassName="sm:max-w-4xl"
      bodyClassName="overflow-hidden"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="grid min-h-[420px] grid-cols-1 gap-4 sm:grid-cols-[200px_minmax(0,1fr)]">
        <nav className="flex gap-1 overflow-x-auto border-b pb-2 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3">
          {sections.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={cn(
                "flex shrink-0 items-start gap-2 rounded-md px-3 py-2 text-left transition-colors sm:w-full",
                section === item.key ? "bg-muted text-primary" : "hover:bg-muted/60"
              )}
            >
              <item.icon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{item.summary}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="app-scrollbar min-h-0 overflow-y-auto pr-1">
          {section === "tags" ? (
            <SectionBody title="文档标签" hint="为本批文档打标签，之后可在文档列表里按标签筛选。">
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {tags.length === 0 ? <span className="text-sm text-muted-foreground">还没有选择标签</span> : null}
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1 pr-1 font-normal">
                      {tag}
                      <button
                        type="button"
                        aria-label={`移除标签 ${tag}`}
                        className="rounded-sm text-muted-foreground hover:text-foreground"
                        onClick={() => patch({ tags: tags.filter((item) => item !== tag) })}
                      >
                        <X className="size-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    value={tagDraft}
                    placeholder="输入标签后回车添加"
                    onChange={(event) => setTagDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return
                      event.preventDefault()
                      addTag(tagDraft)
                    }}
                  />
                  <Button variant="outline" onClick={() => addTag(tagDraft)} disabled={!tagDraft.trim()}>
                    添加
                  </Button>
                </div>
                {availableTags.length > 0 ? (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">知识库已有标签</p>
                    <div className="flex flex-wrap gap-1.5">
                      {availableTags
                        .filter((tag) => !tags.includes(tag))
                        .map((tag) => (
                          <button
                            key={tag}
                            type="button"
                            className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                            onClick={() => addTag(tag)}
                          >
                            {tag}
                          </button>
                        ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </SectionBody>
          ) : null}

          {section === "engine" ? (
            <SectionBody title="解析引擎" hint="决定正文从哪里来。扫描件没有文本层，只能靠多模态识别。">
              <div className="space-y-2">
                <EngineOption
                  active={value.parseEngine === "auto"}
                  title="默认（本地优先）"
                  detail="服务端本地抽取文本；抽不动的扫描页交给图像处理阶段兜底。"
                  onSelect={() => patch({ parseEngine: "auto" })}
                />
                <EngineOption
                  active={value.parseEngine === "local"}
                  title="仅本地抽取"
                  detail="完全不调用模型，最省额度。扫描件会因为抽不到正文而解析失败。"
                  onSelect={() => patch({ parseEngine: "local" })}
                />
                <EngineOption
                  active={value.parseEngine === "scan"}
                  title="按扫描件解析"
                  detail="整份逐页交给多模态识别，适用于扫描件、图片型 PDF 与网页打印件。耗时和模型调用都会明显增加，并会自动开启图像处理。"
                  onSelect={() => patch({ parseEngine: "scan", multimodal: { ...value.multimodal, enabled: true } })}
                />
              </div>
            </SectionBody>
          ) : null}

          {section === "chunking" ? (
            <SectionBody title="分块设置" hint="留空即沿用知识库默认配置；这里的改动只影响本次解析。">
              <div className="space-y-4">
                <Field label="分块策略">
                  <Select
                    value={strategy}
                    onValueChange={(next) => patchChunking({ strategy: next as KnowledgeBaseChunkStrategy })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STRATEGY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="分块大小（字符）">
                    <Input
                      type="number"
                      min={64}
                      max={8192}
                      value={chunkSize}
                      onChange={(event) => patchChunking({ chunkSize: Number(event.target.value) })}
                    />
                  </Field>
                  <Field label="分块重叠（字符）">
                    <Input
                      type="number"
                      min={0}
                      max={2048}
                      value={chunkOverlap}
                      onChange={(event) => patchChunking({ chunkOverlap: Number(event.target.value) })}
                    />
                  </Field>
                </div>
                <ToggleRow
                  title="父子分块"
                  detail="小的子块用于向量匹配，命中后把大的父块回填给模型，上下文更完整。"
                  checked={parentChild}
                  onCheckedChange={(checked) => patchChunking({ enableParentChild: checked })}
                />
                {parentChild ? (
                  <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
                    <Field label="父块大小（0 = 默认 4096）">
                      <Input
                        type="number"
                        min={0}
                        max={8192}
                        value={value.chunking.parentChunkSize ?? knowledgeBase.parentChunkSize}
                        onChange={(event) => patchChunking({ parentChunkSize: Number(event.target.value) })}
                      />
                    </Field>
                    <Field label="子块大小（0 = 默认 384）">
                      <Input
                        type="number"
                        min={0}
                        max={2048}
                        value={value.chunking.childChunkSize ?? knowledgeBase.childChunkSize}
                        onChange={(event) => patchChunking({ childChunkSize: Number(event.target.value) })}
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            </SectionBody>
          ) : null}

          {section === "image" ? (
            <SectionBody title="图像处理配置" hint="配置图像内容理解能力，启用后支持图片等非文本内容的解析和检索。">
              <div className="space-y-4">
                <ToggleRow
                  title="多模态功能"
                  detail="只对没有文本层的页生效：纯文字 PDF 一页都不会送进模型，扫描页才会被识别成可检索文本。"
                  checked={value.multimodal.enabled}
                  disabled={value.parseEngine === "scan"}
                  onCheckedChange={(checked) => patch({ multimodal: { ...value.multimodal, enabled: checked } })}
                />
                {value.parseEngine === "scan" ? (
                  <p className="text-xs text-muted-foreground">解析引擎选了「按扫描件解析」，多模态必须开启。</p>
                ) : !value.multimodal.enabled ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    关闭后，扫描件这类没有文本层的文档会因为抽不到正文而解析失败。
                  </p>
                ) : null}
                {value.multimodal.enabled ? (
                  <Field label="多模态模型">
                    <Select
                      value={value.multimodal.modelConfigId ?? ""}
                      disabled={visionModelsLoading}
                      onValueChange={(next) => patch({ multimodal: { ...value.multimodal, modelConfigId: next } })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={visionModelsLoading ? "加载中…" : "选择多模态模型"} />
                      </SelectTrigger>
                      <SelectContent>
                        {visionModels.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.name}
                            {model.isDefault ? "（默认）" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!visionModelsLoading && visionModels.length === 0 ? (
                      <p className="mt-1.5 text-xs text-destructive">
                        还没有可用的多模态模型，可到「模型中心 → 多模态」新增并启用。
                      </p>
                    ) : null}
                  </Field>
                ) : null}
              </div>
            </SectionBody>
          ) : null}

          {section === "question" ? (
            <SectionBody
              title="AI 问题生成"
              hint="解析文档时调用大模型为每个分块生成相关问题，提高检索召回率。启用后会增加文档解析耗时。"
            >
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">AI 问题生成</p>
                    <p className="text-xs text-muted-foreground">每个文档分块生成的问题数量（1-{MAX_QUESTIONS_PER_CHUNK}）</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Input
                      type="number"
                      min={1}
                      max={MAX_QUESTIONS_PER_CHUNK}
                      className="h-9 w-20"
                      disabled={!value.questionGeneration.enabled}
                      value={value.questionGeneration.questionCount}
                      onChange={(event) =>
                        patch({
                          questionGeneration: {
                            ...value.questionGeneration,
                            questionCount: clampQuestionCount(Number(event.target.value)),
                          },
                        })
                      }
                    />
                    <Switch
                      checked={value.questionGeneration.enabled}
                      onCheckedChange={(checked) =>
                        patch({ questionGeneration: { ...value.questionGeneration, enabled: checked } })
                      }
                    />
                  </div>
                </div>

                <div className="space-y-1.5 border-t pt-4">
                  <Label htmlFor="question-instructions">问题生成要求</Label>
                  <p className="text-xs text-muted-foreground">指定问题面向的人群、场景和表达方式，系统仍维护稳定输出格式</p>
                  <Textarea
                    id="question-instructions"
                    rows={4}
                    maxLength={MAX_QUESTION_INSTRUCTIONS}
                    disabled={!value.questionGeneration.enabled}
                    placeholder="例如：生成客服用户常问的自然语言问题，避免考试题式表达…"
                    value={instructions}
                    onChange={(event) =>
                      patch({
                        questionGeneration: { ...value.questionGeneration, customInstructions: event.target.value },
                      })
                    }
                  />
                  <p className="text-right text-xs text-muted-foreground">
                    {instructions.length}/{MAX_QUESTION_INSTRUCTIONS}
                  </p>
                </div>
              </div>
            </SectionBody>
          ) : null}
        </div>
      </div>
    </ModalShell>
  )
}

function clampQuestionCount(value: number): number {
  if (!Number.isFinite(value)) return 3
  return Math.max(1, Math.min(Math.round(value), MAX_QUESTIONS_PER_CHUNK))
}

function SectionBody({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4 px-1">
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{hint}</p>
      </div>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {children}
    </div>
  )
}

function ToggleRow({
  title,
  detail,
  checked,
  disabled,
  onCheckedChange,
}: {
  title: string
  detail: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <Switch className="shrink-0" checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  )
}

function EngineOption({
  active,
  title,
  detail,
  onSelect,
}: {
  active: boolean
  title: string
  detail: string
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-md border px-3 py-2.5 text-left transition-colors",
        active ? "border-primary/60 bg-primary/5" : "hover:border-primary/40"
      )}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{detail}</span>
    </button>
  )
}

export default DocumentParseConfigDialog
