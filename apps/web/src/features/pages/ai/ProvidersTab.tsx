"use client"

import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Zap,
} from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { ActionMenu } from "@/components/petrichor-ui/action-menu"
import { notify } from "@/components/petrichor-ui/notify"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import {
  aiModelApi,
  aiProviderApi,
  type AiApiProtocol,
  type AiCredentialResponse,
  type AiDiscoveredModel,
  type AiModelKind,
  type AiProviderCatalogItem,
  type AiProviderResponse,
} from "@/lib/api"
import { ACCENT_CLASS, errorMessage, formatContextWindow, formatDateTime } from "./provider-ui"

interface ProvidersTabProps {
  catalog: AiProviderCatalogItem[]
  credentials: AiCredentialResponse[]
  providers: AiProviderResponse[]
  loading: boolean
  onChanged: () => void | Promise<void>
}

export function ProvidersTab({
  catalog,
  credentials,
  providers,
  loading,
  onChanged,
}: ProvidersTabProps) {
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<AiProviderResponse | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)

  const [providerKey, setProviderKey] = React.useState("")
  const [name, setName] = React.useState("")
  const [baseUrl, setBaseUrl] = React.useState("")
  const [credentialId, setCredentialId] = React.useState("")
  const [enabled, setEnabled] = React.useState(true)
  const [headersText, setHeadersText] = React.useState("")
  const [apiProtocol, setApiProtocol] = React.useState<AiApiProtocol>("chat")

  const [modelsOpen, setModelsOpen] = React.useState(false)
  const [modelsTarget, setModelsTarget] = React.useState<AiProviderResponse | null>(null)

  // 表单内的模型拉取：先拿到列表，再从中挑要启用的和用于测试的那一个
  const [draftModels, setDraftModels] = React.useState<AiDiscoveredModel[]>([])
  const [draftSelected, setDraftSelected] = React.useState<Set<string>>(new Set())
  const [draftKinds, setDraftKinds] = React.useState<Record<string, AiModelKind>>({})
  const [testModelId, setTestModelId] = React.useState("")
  const [fetchingModels, setFetchingModels] = React.useState(false)
  const [modelsWarning, setModelsWarning] = React.useState<string | null>(null)

  const resetDraftModels = React.useCallback(() => {
    setDraftModels([])
    setDraftSelected(new Set())
    setDraftKinds({})
    setTestModelId("")
    setModelsWarning(null)
  }, [])

  const selectedCatalog = React.useMemo(
    () => catalog.find((item) => item.key === providerKey) ?? null,
    [catalog, providerKey]
  )

  // 供应商可用的凭证：通用凭证 + 限定为该供应商的凭证
  const usableCredentials = React.useMemo(
    () => credentials.filter((item) => !item.providerKey || item.providerKey === providerKey),
    [credentials, providerKey]
  )

  const openCreate = React.useCallback(() => {
    setEditing(null)
    setProviderKey("")
    setName("")
    setBaseUrl("")
    setCredentialId(credentials[0]?.id ?? "")
    setEnabled(true)
    setHeadersText("")
    setApiProtocol("chat")
    resetDraftModels()
    setEditorOpen(true)
  }, [credentials, resetDraftModels])

  const openEdit = React.useCallback((record: AiProviderResponse) => {
    setEditing(record)
    setProviderKey(record.providerKey)
    setName(record.name)
    setBaseUrl(record.baseUrl ?? "")
    setCredentialId(record.credentialId)
    setEnabled(record.enabled)
    setHeadersText(
      Object.keys(record.headers).length > 0 ? JSON.stringify(record.headers, null, 2) : ""
    )
    setApiProtocol(record.apiProtocol)
    resetDraftModels()
    setEditorOpen(true)

    // 载入已保存的模型，这样编辑时不用重新拉取就能看到现状、也能直接测试
    void (async () => {
      try {
        const res = await aiModelApi.list({ providerId: record.id })
        const items: AiDiscoveredModel[] = res.data.items.map((model) => ({
          modelId: model.modelId,
          kind: model.kind,
          label: model.displayName,
          contextWindow: model.contextWindow ?? 0,
          preset: false,
          saved: true,
          enabled: model.enabled,
          dimensions: model.dimensions,
        }))
        setDraftModels(items)
        setDraftSelected(new Set(items.filter((item) => item.enabled).map((item) => item.modelId)))
        setTestModelId(items.find((item) => item.kind === "LANGUAGE")?.modelId ?? "")
      } catch {
        // 拉不到就当作还没拉取过，用户可以手动点「获取模型列表」
      }
    })()
  }, [resetDraftModels])

  /** 选中供应商时自动带出默认名称，名称没被手动改过才覆盖 */
  const handlePickProvider = React.useCallback(
    (key: string) => {
      const item = catalog.find((entry) => entry.key === key)
      setProviderKey(key)
      // 换了供应商，之前拉到的模型列表不再适用
      resetDraftModels()
      // 协议按新供应商的默认值重置，避免把上一家的选择带过来
      setApiProtocol(item?.apiProtocols[0] ?? "chat")
      if (item && (!name.trim() || catalog.some((entry) => entry.name === name))) {
        setName(item.name)
      }
      // 切换供应商后旧的凭证可能不再适用
      const stillUsable = credentials.find(
        (credential) =>
          credential.id === credentialId && (!credential.providerKey || credential.providerKey === key)
      )
      if (!stillUsable) {
        const next = credentials.find((credential) => !credential.providerKey || credential.providerKey === key)
        setCredentialId(next?.id ?? "")
      }
    },
    [catalog, credentialId, credentials, name, resetDraftModels]
  )

  const parseHeaders = React.useCallback((): Record<string, string> | null => {
    const text = headersText.trim()
    if (!text) return {}
    try {
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)])
      )
    } catch {
      return null
    }
  }, [headersText])

  const buildPayload = React.useCallback(() => {
    if (!providerKey) {
      toast.error("请选择供应商")
      return null
    }
    if (!credentialId) {
      toast.error("请选择凭证")
      return null
    }
    const headers = parseHeaders()
    if (headers == null) {
      toast.error("自定义请求头不是合法的 JSON 对象")
      return null
    }
    if (selectedCatalog?.baseUrlRequired && !baseUrl.trim()) {
      toast.error(`${selectedCatalog.name} 必须填写 BaseUrl`)
      return null
    }
    return {
      providerKey,
      name: name.trim() || selectedCatalog?.name || providerKey,
      baseUrl: baseUrl.trim() || null,
      credentialId,
      enabled,
      headers,
      options: { apiProtocol },
    }
  }, [apiProtocol, baseUrl, credentialId, enabled, name, parseHeaders, providerKey, selectedCatalog])

  /**
   * 表单内「获取模型列表」：不需要先保存供应商，
   * 后端支持用草稿（providerKey + credentialId + baseUrl）直接去打 /models。
   */
  const handleFetchModels = React.useCallback(async () => {
    const payload = buildPayload()
    if (!payload) return

    setFetchingModels(true)
    setModelsWarning(null)
    try {
      const res = await aiProviderApi.fetchModels(
        editing
          ? { id: editing.id, baseUrl: payload.baseUrl, headers: payload.headers }
          : {
              providerKey: payload.providerKey,
              credentialId: payload.credentialId,
              baseUrl: payload.baseUrl,
              headers: payload.headers,
            }
      )
      const items = res.data.items
      setDraftModels(items)
      setModelsWarning(res.data.warning)
      // 已保存过的保持勾选；首次拉取不预选，避免一次塞进几百个模型
      setDraftSelected(new Set(items.filter((item) => item.enabled).map((item) => item.modelId)))
      setDraftKinds({})
      // 测试默认挑第一个语言模型
      const firstLanguage = items.find((item) => item.kind === "LANGUAGE")
      setTestModelId(firstLanguage?.modelId ?? "")
      if (items.length > 0) {
        notify(`拉取到 ${items.length} 个模型`)
      }
    } catch (error) {
      toast.error(errorMessage(error, "获取模型列表失败"))
    } finally {
      setFetchingModels(false)
    }
  }, [buildPayload, editing])

  const draftKindOf = React.useCallback(
    (model: AiDiscoveredModel) => draftKinds[model.modelId] ?? model.kind,
    [draftKinds]
  )

  const handleSave = React.useCallback(async () => {
    const payload = buildPayload()
    if (!payload) return

    setSaving(true)
    try {
      const saved = editing
        ? await aiProviderApi.update({ id: editing.id, ...payload })
        : await aiProviderApi.create(payload)

      // 表单里勾选过模型就一并落库，省掉「保存完再进管理模型」这一步
      if (draftSelected.size > 0) {
        await aiProviderApi.syncModels({
          providerId: saved.data.id,
          models: draftModels
            .filter((model) => draftSelected.has(model.modelId))
            .map((model) => ({
              modelId: model.modelId,
              displayName: model.label,
              kind: draftKindOf(model),
              contextWindow: model.contextWindow,
              enabled: true,
            })),
        })
        notify(`${editing ? "供应商已更新" : "供应商已接入"}，已启用 ${draftSelected.size} 个模型`)
      } else {
        notify(editing ? "供应商已更新" : "供应商已接入")
      }
      setEditorOpen(false)
      await onChanged()
    } catch (error) {
      toast.error(errorMessage(error, "保存失败"))
    } finally {
      setSaving(false)
    }
  }, [buildPayload, draftKindOf, draftModels, draftSelected, editing, onChanged])

  /** 表单里直接测试，不需要先保存 */
  const handleTestDraft = React.useCallback(async () => {
    const payload = buildPayload()
    if (!payload) return

    setTesting(true)
    try {
      // 带上表单里当前选的协议：测试必须走真实调用会走的那套端点
      const res = await aiProviderApi.test(
        editing
          ? {
              id: editing.id,
              baseUrl: payload.baseUrl,
              headers: payload.headers,
              modelId: testModelId,
              apiProtocol,
            }
          : {
              providerKey: payload.providerKey,
              credentialId: payload.credentialId,
              baseUrl: payload.baseUrl,
              headers: payload.headers,
              modelId: testModelId,
              apiProtocol,
            }
      )
      if (res.data.status === "OK") {
        notify(res.data.message)
      } else {
        toast.error(res.data.message)
      }
    } catch (error) {
      toast.error(errorMessage(error, "测试失败"))
    } finally {
      setTesting(false)
    }
  }, [apiProtocol, buildPayload, editing, testModelId])

  const handleToggleEnabled = React.useCallback(
    async (record: AiProviderResponse, next: boolean) => {
      try {
        await aiProviderApi.update({
          id: record.id,
          providerKey: record.providerKey,
          name: record.name,
          baseUrl: record.baseUrl,
          credentialId: record.credentialId,
          enabled: next,
          headers: record.headers,
        })
        await onChanged()
      } catch (error) {
        toast.error(errorMessage(error, "操作失败"))
      }
    },
    [onChanged]
  )

  const handleDelete = React.useCallback(
    async (record: AiProviderResponse) => {
      try {
        await aiProviderApi.delete({ id: record.id })
        notify("供应商已删除")
        await onChanged()
      } catch (error) {
        toast.error(errorMessage(error, "删除失败"))
      }
    },
    [onChanged]
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          选供应商会自动带出默认 BaseUrl，可按需改成代理地址。接入后点「管理模型」拉取该供应商的模型列表，勾选要启用的即可。
        </p>
        <Button onClick={openCreate} disabled={credentials.length === 0} className="shrink-0">
          <Plus className="size-4" />
          接入供应商
        </Button>
      </div>

      {credentials.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有可用凭证。请先到「凭证」页添加一个 API Key。
        </div>
      ) : null}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>供应商</TableHead>
              <TableHead>BaseUrl</TableHead>
              <TableHead>凭证</TableHead>
              <TableHead className="text-center">模型</TableHead>
              <TableHead>连通性</TableHead>
              <TableHead className="text-center">启用</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="h-28 text-center text-muted-foreground">
                  <Loader2 className="mx-auto size-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-28 text-center text-sm text-muted-foreground">
                  还没有接入任何供应商。
                </TableCell>
              </TableRow>
            ) : (
              providers.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="font-medium">{record.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={cn("border font-normal", ACCENT_CLASS[record.accent])}
                    >
                      {record.providerName}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[240px] truncate font-mono text-xs text-muted-foreground">
                    {record.effectiveBaseUrl ?? "SDK 默认"}
                  </TableCell>
                  <TableCell className="text-sm">{record.credentialName ?? "-"}</TableCell>
                  <TableCell className="text-center text-sm">
                    {record.modelCount === 0 ? (
                      <span className="text-muted-foreground">未拉取</span>
                    ) : (
                      <span>
                        {record.enabledModelCount}
                        <span className="text-muted-foreground"> / {record.modelCount}</span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <CheckStatus record={record} />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={record.enabled}
                      onCheckedChange={(next) => void handleToggleEnabled(record, next)}
                    />
                  </TableCell>
                  <TableCell>
                    <ActionMenu
                      trigger={
                        <Button variant="ghost" size="icon" className="size-8">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      }
                    >
                      <DropdownMenuItem
                        onSelect={() => {
                          setModelsTarget(record)
                          setModelsOpen(true)
                        }}
                      >
                        管理模型
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => openEdit(record)}>编辑</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => void handleDelete(record)}
                      >
                        删除
                      </DropdownMenuItem>
                    </ActionMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <ModalShell
        open={editorOpen}
        onOpenChange={setEditorOpen}
        title={editing ? "编辑供应商" : "接入供应商"}
        description={selectedCatalog?.description}
        contentClassName="sm:max-w-2xl"
        footer={
          <div className="flex justify-between gap-2">
            <Button
              variant="outline"
              onClick={() => void handleTestDraft()}
              disabled={saving || testing || !providerKey || !credentialId || !testModelId}
              title={testModelId ? `用 ${testModelId} 发一次最小请求` : "请先获取模型列表并选择测试模型"}
            >
              {testing ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
              测试连通
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
                取消
              </Button>
              <Button onClick={() => void handleSave()} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                保存
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>供应商</Label>
            <Select value={providerKey} onValueChange={handlePickProvider}>
              <SelectTrigger>
                <SelectValue placeholder="选择供应商" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {catalog.map((item) => (
                  <SelectItem key={item.key} value={item.key}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedCatalog ? (
              <p className="text-xs text-muted-foreground">
                支持 {selectedCatalog.kinds.map((kind) => (kind === "LANGUAGE" ? "语言模型" : "向量模型")).join(" / ")}
                {selectedCatalog.supportsModelListing ? "，可在线拉取模型列表" : "，无在线模型列表接口，使用内置清单"}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label>名称</Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="用于区分同一供应商的多个接入点"
            />
          </div>

          <div className="space-y-2">
            <Label>
              BaseUrl
              {selectedCatalog?.baseUrlRequired ? <span className="ml-1 text-destructive">*</span> : null}
            </Label>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder={selectedCatalog?.defaultBaseUrl ?? "https://..."}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {selectedCatalog?.defaultBaseUrl
                ? `留空使用默认值 ${selectedCatalog.defaultBaseUrl}`
                : selectedCatalog?.baseUrlRequired
                  ? "该供应商没有默认地址，必须填写"
                  : "该供应商由 SDK 自行拼接地址，通常不需要填"}
            </p>
          </div>

          {(selectedCatalog?.apiProtocols.length ?? 0) > 1 ? (
            <div className="space-y-2">
              <Label>接口协议</Label>
              <Select
                value={apiProtocol}
                onValueChange={(value) => setApiProtocol(value as AiApiProtocol)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedCatalog?.apiProtocols.map((protocol) => (
                    <SelectItem key={protocol} value={protocol}>
                      {protocol === "chat" ? "Chat Completions" : "Responses"}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {protocol === "chat" ? "/chat/completions" : "/responses"}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                中转网关、私有部署和本地推理服务通常只实现了 Chat Completions；
                只有直连官方端点、且要用 Responses 专属能力时才切到 Responses。
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>凭证</Label>
            <Select value={credentialId} onValueChange={setCredentialId}>
              <SelectTrigger>
                <SelectValue placeholder="选择一条凭证" />
              </SelectTrigger>
              <SelectContent>
                {usableCredentials.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {item.apiKeyMasked}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {usableCredentials.length === 0 ? (
              <p className="text-xs text-destructive">
                没有适用于该供应商的凭证，请先到「凭证」页添加。
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label>启用</Label>
              <p className="text-xs text-muted-foreground">停用后其下所有模型都不可用</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div className="space-y-2">
            <Label>自定义请求头（可选）</Label>
            <Textarea
              value={headersText}
              onChange={(event) => setHeadersText(event.target.value)}
              placeholder={'{\n  "HTTP-Referer": "https://example.com"\n}'}
              rows={4}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              JSON 对象。OpenRouter 的排行榜归属、企业网关的租户标识等可以放在这里。
            </p>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label>模型</Label>
                <p className="text-xs text-muted-foreground">
                  先拉取列表再勾选，不用手输模型名。勾选的模型会随保存一起启用。
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleFetchModels()}
                disabled={fetchingModels || !providerKey || !credentialId}
              >
                {fetchingModels ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                获取模型列表
              </Button>
            </div>

            {modelsWarning ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:border-amber-900 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{modelsWarning}</span>
              </div>
            ) : null}

            {draftModels.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                {providerKey && credentialId
                  ? "还没有拉取模型。点右上角「获取模型列表」。"
                  : "先选好供应商和凭证，再获取模型列表。"}
              </div>
            ) : (
              <>
                <div className="max-h-56 overflow-y-auto rounded-lg border">
                  {draftModels.map((model) => (
                    <label
                      key={model.modelId}
                      className="flex cursor-pointer items-center gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={draftSelected.has(model.modelId)}
                        onCheckedChange={(checked) =>
                          setDraftSelected((prev) => {
                            const next = new Set(prev)
                            if (checked) next.add(model.modelId)
                            else next.delete(model.modelId)
                            return next
                          })
                        }
                      />
                      <span className="flex-1 truncate font-mono text-xs">{model.modelId}</span>
                      {model.preset ? (
                        <Badge variant="secondary" className="font-normal">
                          内置
                        </Badge>
                      ) : null}
                      <Badge variant="outline" className="font-normal">
                        {draftKindOf(model) === "EMBEDDING" ? "向量" : "语言"}
                      </Badge>
                    </label>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>已勾选 {draftSelected.size} / {draftModels.length}</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() => setDraftSelected(new Set(draftModels.map((m) => m.modelId)))}
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() => setDraftSelected(new Set())}
                    >
                      清空
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>测试用模型</Label>
                  <Select value={testModelId} onValueChange={setTestModelId}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择一个语言模型用于测试" />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {draftModels
                        .filter((model) => draftKindOf(model) === "LANGUAGE")
                        .map((model) => (
                          <SelectItem key={model.modelId} value={model.modelId}>
                            {model.modelId}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    「测试连通」会用这个模型发一次最小请求，一次性验出 Key、地址、模型名和鉴权方式。
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </ModalShell>

      <ModelManagerModal
        open={modelsOpen}
        onOpenChange={setModelsOpen}
        provider={modelsTarget}
        onSaved={onChanged}
      />
    </div>
  )
}

function CheckStatus({ record }: { record: AiProviderResponse }) {
  if (!record.lastCheckStatus) {
    return <span className="text-sm text-muted-foreground">未测试</span>
  }
  const ok = record.lastCheckStatus === "OK"
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-sm",
        ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
      )}
      title={`${record.lastCheckMessage ?? ""}\n${formatDateTime(record.lastCheckedAt)}`}
    >
      {ok ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
      {ok ? "正常" : "失败"}
    </span>
  )
}

interface ModelManagerModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: AiProviderResponse | null
  onSaved: () => void | Promise<void>
}

/**
 * 模型管理弹窗：拉取 → 勾选 → 保存。
 * 这是整套配置流程里替代「手输模型名」的那一步。
 */
function ModelManagerModal({ open, onOpenChange, provider, onSaved }: ModelManagerModalProps) {
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
    [kindOverrides]
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
              {fetching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
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
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="筛选模型…"
            className="pl-9"
          />
        </div>

        <div className="max-h-[420px] overflow-y-auto rounded-lg border">
          {fetching ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : visible.length === 0 ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              没有匹配的模型
            </div>
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
                      {model.preset ? (
                        <Badge variant="secondary" className="ml-2 font-normal">
                          内置
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Select
                        value={kindOf(model)}
                        onValueChange={(value) =>
                          setKindOverrides((prev) => ({
                            ...prev,
                            [model.modelId]: value as AiModelKind,
                          }))
                        }
                      >
                        <SelectTrigger size="sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="LANGUAGE">语言</SelectItem>
                          <SelectItem value="EMBEDDING">向量</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {kindOf(model) === "EMBEDDING"
                        ? model.dimensions
                          ? `${model.dimensions} 维`
                          : "维度待探测"
                        : formatContextWindow(model.contextWindow)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          类型由模型名推断，遇到判断错误可以在这一列手动改。向量模型的维度不需要填：
          保存并绑定到「向量嵌入」用途时会自动探测，索引也会按该维度自动建好。
        </p>
      </div>
    </ModalShell>
  )
}
