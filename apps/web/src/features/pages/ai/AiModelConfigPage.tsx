"use client"

import * as React from "react"
import { BrainCircuit, KeyRound, Link2, Server } from "@/components/iconimate"
import { toast } from "sonner"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  aiBindingApi,
  aiCredentialApi,
  aiModelApi,
  aiProviderApi,
  type AiBindingSlot,
  type AiCredentialResponse,
  type AiModelResponse,
  type AiProviderCatalogItem,
  type AiProviderResponse,
} from "@/lib/api"
import { CredentialsTab } from "./CredentialsTab"
import { ProvidersTab } from "./ProvidersTab"
import { BindingsTab } from "./BindingsTab"
import { errorMessage } from "./provider-ui"

/**
 * 模型配置页。
 *
 * 配置流程是三步走的：凭证（放 Key）→ 供应商（接入端点、拉模型）→ 用途绑定（把模型挂到业务用途）。
 * 三个 Tab 共享同一份数据，任意一处改动都整体刷新，避免出现「刚加的凭证在供应商页看不到」。
 */
export function AiModelConfigPage() {
  const [catalog, setCatalog] = React.useState<AiProviderCatalogItem[]>([])
  const [credentials, setCredentials] = React.useState<AiCredentialResponse[]>([])
  const [providers, setProviders] = React.useState<AiProviderResponse[]>([])
  const [models, setModels] = React.useState<AiModelResponse[]>([])
  const [slots, setSlots] = React.useState<AiBindingSlot[]>([])
  const [loading, setLoading] = React.useState(true)

  const refresh = React.useCallback(async () => {
    try {
      const [catalogRes, credentialRes, providerRes, modelRes, bindingRes] = await Promise.all([
        aiProviderApi.catalog(),
        aiCredentialApi.list(),
        aiProviderApi.list(),
        aiModelApi.list({}),
        aiBindingApi.list(),
      ])
      setCatalog(catalogRes.data.items)
      setCredentials(credentialRes.data.items)
      setProviders(providerRes.data.items)
      setModels(modelRes.data.items)
      setSlots(bindingRes.data.items)
    } catch (error) {
      toast.error(errorMessage(error, "加载模型配置失败"))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const boundCount = slots.filter((slot) => slot.binding).length

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-4 md:p-6">
      <header className="space-y-1.5">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <BrainCircuit className="size-6" />
          模型配置
        </h1>
        <p className="text-sm text-muted-foreground">
          先添加 API Key 凭证，再接入供应商并拉取模型列表，最后把模型绑定到具体用途。
        </p>
      </header>

      <Tabs defaultValue="providers" className="space-y-4">
        <TabsList>
          <TabsTrigger value="credentials">
            <KeyRound className="size-4" />
            凭证
            {credentials.length > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">{credentials.length}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="providers">
            <Server className="size-4" />
            供应商
            {providers.length > 0 ? (
              <span className="ml-1 text-xs text-muted-foreground">{providers.length}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="bindings">
            <Link2 className="size-4" />
            用途绑定
            <span className="ml-1 text-xs text-muted-foreground">{boundCount}/4</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="credentials">
          <CredentialsTab
            catalog={catalog}
            credentials={credentials}
            loading={loading}
            onChanged={refresh}
          />
        </TabsContent>

        <TabsContent value="providers">
          <ProvidersTab
            catalog={catalog}
            credentials={credentials}
            providers={providers}
            loading={loading}
            onChanged={refresh}
          />
        </TabsContent>

        <TabsContent value="bindings">
          <BindingsTab slots={slots} models={models} loading={loading} onChanged={refresh} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
