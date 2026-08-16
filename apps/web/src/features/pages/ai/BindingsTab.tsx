"use client"

import * as React from "react"
import { Link2, Link2Off, Loader2, Settings2 } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { notify } from "@/components/petrichor-ui/notify"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { WheelSelect } from "@/components/ui/wheel-select"
import {
  aiBindingApi,
  type AiBindingSlot,
  type AiModelResponse,
  type AiPurpose,
} from "@/lib/api"
import {
  errorMessage,
  formatContextWindow,
  PURPOSE_LABEL,
  PURPOSE_SUMMARY,
} from "./provider-ui"

interface BindingsTabProps {
  slots: AiBindingSlot[]
  models: AiModelResponse[]
  loading: boolean
  onChanged: () => void | Promise<void>
}

export function BindingsTab({ slots, models, loading, onChanged }: BindingsTabProps) {
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [target, setTarget] = React.useState<AiBindingSlot | null>(null)
  const [saving, setSaving] = React.useState(false)

  const [modelRefId, setModelRefId] = React.useState("")
  const [maxTokens, setMaxTokens] = React.useState("")
  const [temperature, setTemperature] = React.useState("")
  const [thinking, setThinking] = React.useState(false)

  const openEditor = React.useCallback((slot: AiBindingSlot) => {
    setTarget(slot)
    setModelRefId(slot.binding?.modelRefId ?? "")
    setMaxTokens(slot.binding?.options.maxTokens ? String(slot.binding.options.maxTokens) : "")
    setTemperature(
      slot.binding?.options.temperature != null ? String(slot.binding.options.temperature) : ""
    )
    setThinking(slot.binding?.options.thinking === "enabled")
    setEditorOpen(true)
  }, [])

  /** 候选模型按用途所需的类型过滤：EMBEDDING 只能选向量模型，其余只能选语言模型 */
  const candidates = React.useMemo(() => {
    if (!target) return []
    return models.filter((model) => model.kind === target.requiredKind && model.enabled)
  }, [models, target])

  const handleSave = React.useCallback(async () => {
    if (!target) return
    if (!modelRefId) {
      toast.error("请选择一个模型")
      return
    }
    setSaving(true)
    try {
      await aiBindingApi.set({
        purpose: target.purpose,
        modelRefId,
        options: {
          maxTokens: maxTokens.trim() ? Number(maxTokens) : null,
          temperature: temperature.trim() ? Number(temperature) : null,
          thinking: thinking ? "enabled" : null,
          disableThinkingForTools: true,
        },
      })
      notify(`${PURPOSE_LABEL[target.purpose]} 已绑定`)
      setEditorOpen(false)
      await onChanged()
    } catch (error) {
      toast.error(errorMessage(error, "绑定失败"))
    } finally {
      setSaving(false)
    }
  }, [maxTokens, modelRefId, onChanged, target, temperature, thinking])

  const handleClear = React.useCallback(
    async (purpose: AiPurpose) => {
      try {
        await aiBindingApi.clear({ purpose })
        notify("已解除绑定")
        await onChanged()
      } catch (error) {
        toast.error(errorMessage(error, "解绑失败"))
      }
    },
    [onChanged]
  )

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        每个用途绑定一个模型。业务代码只认用途，换模型不需要改任何代码。
      </p>

      <div className="grid gap-3 md:grid-cols-2">
        {slots.map((slot) => {
          const bound = slot.binding
          const available = models.filter(
            (model) => model.kind === slot.requiredKind && model.enabled
          ).length
          return (
            <div
              key={slot.purpose}
              className={cn(
                "flex flex-col justify-between rounded-lg border p-4",
                !bound && "border-dashed"
              )}
            >
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{PURPOSE_LABEL[slot.purpose]}</span>
                  <Badge variant="outline" className="font-normal">
                    {slot.requiredKind === "EMBEDDING" ? "向量模型" : "语言模型"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">{PURPOSE_SUMMARY[slot.purpose]}</p>
              </div>

              <div className="mt-4 space-y-3">
                {bound ? (
                  <div className="rounded-md bg-muted/50 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Link2 className="size-4 text-emerald-600 dark:text-emerald-400" />
                      {bound.modelDisplayName || bound.modelId}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{bound.providerName}</span>
                      {slot.requiredKind === "EMBEDDING" ? (
                        <span>{bound.dimensions ? `${bound.dimensions} 维` : "维度待探测"}</span>
                      ) : bound.contextWindow ? (
                        <span>上下文 {formatContextWindow(bound.contextWindow)}</span>
                      ) : null}
                      {bound.options.temperature != null ? (
                        <span>temp {bound.options.temperature}</span>
                      ) : null}
                      {bound.options.thinking === "enabled" ? <span>思考模式</span> : null}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    {available === 0
                      ? `还没有可用的${slot.requiredKind === "EMBEDDING" ? "向量" : "语言"}模型，请先在「供应商」页接入并拉取模型。`
                      : `未绑定，有 ${available} 个可选模型。`}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    disabled={available === 0}
                    onClick={() => openEditor(slot)}
                  >
                    <Settings2 className="size-4" />
                    {bound ? "改绑 / 调参" : "绑定模型"}
                  </Button>
                  {bound ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleClear(slot.purpose)}
                    >
                      <Link2Off className="size-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      <ModalShell
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={target ? `绑定 · ${PURPOSE_LABEL[target.purpose]}` : "绑定模型"}
        description={target ? PURPOSE_SUMMARY[target.purpose] : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>模型</Label>
            <WheelSelect
              value={modelRefId}
              onValueChange={setModelRefId}
              placeholder="选择模型"
              label="选择模型"
              items={candidates.map((model) => ({
                value: model.id,
                label: model.displayName || model.modelId,
                hint: `${model.providerName}${
                  model.kind === "EMBEDDING" && model.dimensions ? ` · ${model.dimensions} 维` : ""
                }`,
              }))}
            />
          </div>

          {target?.requiredKind === "LANGUAGE" ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>最大输出 tokens</Label>
                  <Input
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="留空用模型默认"
                    inputMode="numeric"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Temperature</Label>
                  <Input
                    value={temperature}
                    onChange={(event) => setTemperature(event.target.value)}
                    placeholder="留空用模型默认"
                    inputMode="decimal"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <Label>思考模式</Label>
                  <p className="text-xs text-muted-foreground">
                    仅对 DeepSeek 等支持 thinking 开关的模型生效；带工具调用的请求会自动关闭。
                  </p>
                </div>
                <Switch checked={thinking} onCheckedChange={setThinking} />
              </div>
            </>
          ) : (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
              维度会在绑定时自动探测，无需填写。换成不同维度的模型不会破坏已有数据：
              旧维度的向量原样保留，只是会被判定为待重算，重新生成即可。
            </p>
          )}
        </div>
      </ModalShell>
    </div>
  )
}
