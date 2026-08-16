"use client"

import * as React from "react"
import { KeyRound, Loader2, MoreHorizontal, Plus } from "lucide-react"
import { toast } from "sonner"

import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { ActionMenu } from "@/components/petrichor-ui/action-menu"
import { notify } from "@/components/petrichor-ui/notify"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { WheelSelect } from "@/components/ui/wheel-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  aiCredentialApi,
  type AiCredentialResponse,
  type AiProviderCatalogItem,
} from "@/lib/api"
import { errorMessage, formatDateTime } from "./provider-ui"

interface CredentialsTabProps {
  catalog: AiProviderCatalogItem[]
  credentials: AiCredentialResponse[]
  loading: boolean
  onChanged: () => void | Promise<void>
}

const ANY_PROVIDER = "__ANY__"

export function CredentialsTab({ catalog, credentials, loading, onChanged }: CredentialsTabProps) {
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<AiCredentialResponse | null>(null)
  const [saving, setSaving] = React.useState(false)

  const [name, setName] = React.useState("")
  const [providerKey, setProviderKey] = React.useState<string>(ANY_PROVIDER)
  const [apiKey, setApiKey] = React.useState("")
  const [extra, setExtra] = React.useState<Record<string, string>>({})

  // 选了具体供应商时，把它的额外凭证字段（Bedrock AK/SK、Vertex 服务账号）也渲染出来
  const selectedProvider = React.useMemo(
    () => catalog.find((item) => item.key === providerKey) ?? null,
    [catalog, providerKey]
  )

  const openCreate = React.useCallback(() => {
    setEditing(null)
    setName("")
    setProviderKey(ANY_PROVIDER)
    setApiKey("")
    setExtra({})
    setEditorOpen(true)
  }, [])

  const openEdit = React.useCallback((record: AiCredentialResponse) => {
    setEditing(record)
    setName(record.name)
    setProviderKey(record.providerKey ?? ANY_PROVIDER)
    setApiKey("")
    setExtra({})
    setEditorOpen(true)
  }, [])

  const handleSave = React.useCallback(async () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error("请填写凭证名称")
      return
    }
    if (!editing && !apiKey.trim()) {
      toast.error("请填写 API Key")
      return
    }

    setSaving(true)
    try {
      const payload = {
        name: trimmedName,
        providerKey: providerKey === ANY_PROVIDER ? null : providerKey,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(Object.keys(extra).length > 0 ? { extra } : {}),
      }
      if (editing) {
        await aiCredentialApi.update({ id: editing.id, ...payload })
        notify("凭证已更新")
      } else {
        await aiCredentialApi.create(payload)
        notify("凭证已添加")
      }
      setEditorOpen(false)
      await onChanged()
    } catch (error) {
      toast.error(errorMessage(error, "保存失败"))
    } finally {
      setSaving(false)
    }
  }, [apiKey, editing, extra, name, onChanged, providerKey])

  const handleDelete = React.useCallback(
    async (record: AiCredentialResponse) => {
      try {
        await aiCredentialApi.delete({ id: record.id })
        notify("凭证已删除")
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
          API Key 在这里统一保管，接入供应商时下拉选择即可。同一个 Key 可以被多个供应商复用，轮换时只改这一处。
        </p>
        <Button onClick={openCreate} className="shrink-0">
          <Plus className="size-4" />
          添加凭证
        </Button>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>限定供应商</TableHead>
              <TableHead>API Key</TableHead>
              <TableHead className="text-center">被引用</TableHead>
              <TableHead>最近使用</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="h-28 text-center text-muted-foreground">
                  <Loader2 className="mx-auto size-5 animate-spin" />
                </TableCell>
              </TableRow>
            ) : credentials.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-28 text-center text-sm text-muted-foreground">
                  还没有凭证。先添加一个 API Key，再去「供应商」页接入模型。
                </TableCell>
              </TableRow>
            ) : (
              credentials.map((record) => (
                <TableRow key={record.id}>
                  <TableCell className="font-medium">
                    <span className="inline-flex items-center gap-2">
                      <KeyRound className="size-4 text-muted-foreground" />
                      {record.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    {record.providerName ? (
                      <Badge variant="outline" className="font-normal">
                        {record.providerName}
                      </Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">通用</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {record.apiKeyMasked ?? "-"}
                    {record.extraKeys.length > 0 ? (
                      <span className="ml-2 text-[11px]">+{record.extraKeys.length} 个附加字段</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-center">
                    {record.usageCount > 0 ? (
                      <Badge variant="secondary" className="font-normal">
                        {record.usageCount}
                      </Badge>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDateTime(record.lastUsedAt)}
                  </TableCell>
                  <TableCell>
                    <ActionMenu
                      trigger={
                        <Button variant="ghost" size="icon" className="size-8">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      }
                    >
                      <DropdownMenuItem onSelect={() => openEdit(record)}>编辑 / 轮换 Key</DropdownMenuItem>
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
        title={editing ? "编辑凭证" : "添加凭证"}
        description={
          editing
            ? "API Key 留空表示不修改，填写则会覆盖旧值。"
            : "给凭证起一个好认的名字，例如「OpenAI 主账号」「公司 Azure」。"
        }
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
            <Label>名称</Label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：OpenAI 主账号"
            />
          </div>

          <div className="space-y-2">
            <Label>限定供应商</Label>
            <WheelSelect
              value={providerKey}
              onValueChange={setProviderKey}
              label="限定供应商"
              items={[
                { value: ANY_PROVIDER, label: "通用（不限定）" },
                ...catalog.map((item) => ({ value: item.key, label: item.name })),
              ]}
            />
            <p className="text-xs text-muted-foreground">
              只影响供应商表单里的筛选提示，不做强制校验。Bedrock、Vertex、Azure 这类需要额外字段的供应商必须在这里选中才能填。
            </p>
          </div>

          <div className="space-y-2">
            <Label>API Key</Label>
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={editing ? "留空则保持不变" : "sk-..."}
            />
          </div>

          {selectedProvider?.credentialFields.map((field) => (
            <div key={field.key} className="space-y-2">
              <Label>{field.label}</Label>
              <Input
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                value={extra[field.key] ?? ""}
                placeholder={field.placeholder ?? (editing ? "留空则保持不变" : "")}
                onChange={(event) =>
                  setExtra((prev) => ({ ...prev, [field.key]: event.target.value }))
                }
              />
            </div>
          ))}
        </div>
      </ModalShell>
    </div>
  )
}
