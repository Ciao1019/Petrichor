"use client"

import * as React from "react"
import { AlertTriangle, Loader2, RefreshCw, Search } from "@/components/iconimate"
import { toast } from "sonner"

import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { notify } from "@/components/petrichor-ui/notify"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { WheelSelect, type WheelSelectItem } from "@/components/ui/wheel-select"
import {
  aiProviderApi,
  type AiDiscoveredModel,
  type AiModelKind,
  type AiProviderResponse,
} from "@/lib/api"
import { errorMessage, formatContextWindow } from "./provider-ui"

const MODEL_KIND_ITEMS: WheelSelectItem[] = [
  { value: "LANGUAGE", label: "语言" },
  { value: "EMBEDDING", label: "向量" },
]

interface ProviderModelManagerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: AiProviderResponse | null
  onSaved: () => void | Promise<void>
}

/** 拉取供应商模型并保存启用状态。 */
export function ProviderModelManagerModal({
  open,
  onOpenChange,
  provider,
  onSaved,
}: ProviderModelManagerModalProps) {
  const [fetching, setFetching] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [models, setModels] = React.useState<AiDiscoveredModel[]>([])
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [kindOverrides, setKindOverrides] = React.useState<Record<string, AiModelKind>>({})
  const [warning, setWarning] = React.useState<string | null>(null)
  const [keyword, setKeyword] = React.useState("")

  const load = React.useCallback(async () => {
    if (!provider) return
    setFetching(true)
    setWarning(null)
    try {
      const res = await aiProviderApi.fetchModels({ id: provider.id })
      setModels(res.data.items)
      setSelected(new Set(res.data.items.filter((item) => item.enabled).map((item) => item.modelId)))
      setKindOverrides({})
      setWarning(res.data.warning)
    } catch (error) {
      toast.error(errorMessage(error, "拉取模型列表失败"))
      setModels([])
    } finally {
      setFetching(false)
    }
  }, [provider])

  React.useEffect(() => {
    if (open && provider) {
      void load()
    } else if (!open) {
      setModels([])
      setSelected(new Set())
      setKeyword("")
      setWarning(null)
    }
  }, [load, open, provider])

  const visible = React.useMemo(() => {
    const text = keyword.trim().toLowerCase()
    if (!text) return models
    return models.filter((item) => item.modelId.toLowerCase().includes(text))
  }, [keyword, models])

  const kindOf = React.useCallback(
    (model: AiDiscoveredModel) => kindOverrides[model.modelId] ?? model.kind,
    [kindOverrides],
  )

  const handleSave = React.useCallback(async () => {
    if (!provider) return
    if (selected.size === 0) {
      toast.error("请至少勾选一个模型")
      return
    }
    setSaving(true)
    try {
      await aiProviderApi.syncModels({
        providerId: provider.id,
        models: models
          .filter((model) => selected.has(model.modelId))
          .map((model) => ({
            modelId: model.modelId,
            displayName: model.label,
            kind: kindOf(model),
            contextWindow: model.contextWindow,
            enabled: true,
          })),
      })
      notify(`已保存 ${selected.size} 个模型`)
      onOpenChange(false)
      await onSaved()
    } catch (error) {
      toast.error(errorMessage(error, "保存失败"))
    } finally {
      setSaving(false)
    }
  }, [kindOf, models, onOpenChange, onSaved, provider, selected])

  return (
    <ModalShell
      open={open}
      onOpenChange={onOpenChange}
      title={`管理模型 · ${provider?.name ?? ""}`}
      description="勾选要启用的模型。列表来自供应商的 /models 接口，拉不到时回退到内置清单。"
      contentClassName="sm:max-w-3xl"
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">已选 {selected.size} 个</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void load()} disabled={fetching || saving}>
              {fetching ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              重新拉取
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving || fetching}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {warning ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-500/10 p-3 text-sm text-amber-700 dark:border-amber-900 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{warning}</span>
          </div>
        ) : null}

        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="筛选模型…" className="pl-9" />
        </div>

        <div className="max-h-[420px] overflow-y-auto rounded-lg border">
          {fetching ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">没有匹配的模型</div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>模型 ID</TableHead>
                  <TableHead className="w-32">类型</TableHead>
                  <TableHead className="w-28 text-right">上下文 / 维度</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((model) => (
                  <TableRow key={model.modelId}>
                    <TableCell>
                      <Checkbox
                        checked={selected.has(model.modelId)}
                        onCheckedChange={(checked) =>
                          setSelected((prev) => {
                            const next = new Set(prev)
                            if (checked) next.add(model.modelId)
                            else next.delete(model.modelId)
                            return next
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {model.modelId}
                      {model.preset ? <Badge variant="secondary" className="ml-2 font-normal">内置</Badge> : null}
                    </TableCell>
                    <TableCell>
                      <WheelSelect
                        size="sm"
                        className="w-28"
                        value={kindOf(model)}
                        onValueChange={(value) => setKindOverrides((prev) => ({ ...prev, [model.modelId]: value as AiModelKind }))}
                        label="模型类型"
                        items={MODEL_KIND_ITEMS}
                      />
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {kindOf(model) === "EMBEDDING"
                        ? model.dimensions ? `${model.dimensions} 维` : "维度待探测"
                        : formatContextWindow(model.contextWindow)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          类型由模型名推断，遇到判断错误可以在这一列手动改。向量模型的维度不需要填：保存并绑定到「向量嵌入」用途时会自动探测，索引也会按该维度自动建好。
        </p>
      </div>
    </ModalShell>
  )
}
