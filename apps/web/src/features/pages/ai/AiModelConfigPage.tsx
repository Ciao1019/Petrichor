"use client"

import * as React from "react"
import { BrainCircuit, Loader2, MoreHorizontal, Search, X } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { KbDialog } from "@/components/shadcn-studio/dialog/dialog-09"
import { KbDropdownMenu } from "@/components/shadcn-studio/dropdown-menu/dropdown-menu-09"
import { toastWithIcon } from "@/components/shadcn-studio/sonner/sonner-03"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AppPagination } from "@/components/app-pagination"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Textarea } from "@/components/ui/textarea"
import {
  aiModelConfigApi,
  type AiConfigType,
  type AiModelConfigCreateRequest,
  type AiModelConfigResponse,
  type AiModelConfigUpdateRequest,
  type AiProtocol,
} from "@/lib/api"

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function protocolLabel(protocol: AiProtocol) {
  switch (protocol) {
    case "OPENAI":
      return "OpenAI"
    case "DEEPSEEK":
      return "DeepSeek"
    case "OPENAI_COMPAT":
      return "OpenAI 兼容"
    case "SILICONFLOW":
      return "SiliconFlow"
    case "GEMINI":
      return "Gemini"
    default:
      return protocol
  }
}

function protocolBadgeClass(protocol: AiProtocol) {
  switch (protocol) {
    case "OPENAI":
      return "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800"
    case "DEEPSEEK":
      return "bg-indigo-500/10 text-indigo-700 border-indigo-200 dark:text-indigo-400 dark:border-indigo-800"
    case "OPENAI_COMPAT":
      return "bg-amber-500/10 text-amber-700 border-amber-200 dark:text-amber-400 dark:border-amber-800"
    case "SILICONFLOW":
      return "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-800"
    case "GEMINI":
      return "bg-sky-500/10 text-sky-700 border-sky-200 dark:text-sky-400 dark:border-sky-800"
    default:
      return "bg-muted text-muted-foreground"
  }
}

function safeTrim(value: string) {
  return value.trim()
}

function configTypeLabel(configType: AiConfigType) {
  return configType === "CHAT" ? "对话（Chat）" : configType
}

function buildEditorDescription() {
  return "对话配置用于文章摘要、思维导图和知识图谱生成。"
}

function buildTypeSummary() {
  return "负责文章摘要、思维导图和知识图谱等生成能力。"
}

function buildModelPlaceholder() {
  return "例如：deepseek-ai/DeepSeek-R1"
}

function buildExtraJsonPlaceholder() {
  return '{"temperature":0.2}'
}

function buildExtraJsonHint() {
  return ""
}

function formatExtraJson(value?: string | null) {
  const text = safeTrim(value ?? "")
  if (!text) return "-"
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

function EllipsisText({
  value,
  tooltip,
  fallback = "-",
  className,
  tooltipClassName,
}: {
  value?: string | null
  tooltip?: React.ReactNode
  fallback?: string
  className?: string
  tooltipClassName?: string
}) {
  const text = typeof value === "string" && value.trim() ? value : fallback
  const tooltipNode = tooltip ?? (text !== fallback ? text : null)
  const [isOverflowing, setIsOverflowing] = React.useState(false)
  const spanRef = React.useRef<HTMLSpanElement | null>(null)

  React.useEffect(() => {
    const el = spanRef.current
    if (!el) return

    const checkOverflow = () => {
      const next = el.scrollWidth > el.clientWidth + 1
      setIsOverflowing(next)
    }

    checkOverflow()

    const ro = new ResizeObserver(() => checkOverflow())
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])

  const shouldShowTooltip = Boolean(tooltipNode) && isOverflowing

  const trigger = (
    <span
      ref={spanRef}
      className={cn("block min-w-0 truncate", className)}
    >
      {text}
    </span>
  )

  if (!shouldShowTooltip) {
    return trigger
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent
        className={cn("max-w-[520px] break-words", tooltipClassName)}
      >
        {tooltipNode}
      </TooltipContent>
    </Tooltip>
  )
}

type EnabledFilter = "ALL" | "true" | "false"
type ProtocolFilter = "ALL" | AiProtocol

export function AiModelConfigPage() {
  const activeType: AiConfigType = "CHAT"

  const [rows, setRows] = React.useState<AiModelConfigResponse[]>([])
  const [total, setTotal] = React.useState(0)
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize] = React.useState(10)
  const [isLoading, setIsLoading] = React.useState(false)
  const [isRefreshing, setIsRefreshing] = React.useState(false)

  const [protocolFilter, setProtocolFilter] = React.useState<ProtocolFilter>("ALL")
  const [enabledFilter, setEnabledFilter] = React.useState<EnabledFilter>("ALL")
  const [keywordInput, setKeywordInput] = React.useState("")
  const [keyword, setKeyword] = React.useState("")

  const [saving, setSaving] = React.useState(false)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [editorMode, setEditorMode] = React.useState<"create" | "edit">("create")
  const [activeConfig, setActiveConfig] = React.useState<AiModelConfigResponse | null>(null)

  const [name, setName] = React.useState("")
  const [protocol, setProtocol] = React.useState<AiProtocol>("OPENAI")
  const [model, setModel] = React.useState("")
  const [baseUrl, setBaseUrl] = React.useState("")
  const [apiKey, setApiKey] = React.useState("")
  const [apiKeyClear, setApiKeyClear] = React.useState(false)
  const [enabled, setEnabled] = React.useState(true)
  const [isDefaultOnCreate, setIsDefaultOnCreate] = React.useState(false)
  const [extraJson, setExtraJson] = React.useState("")

  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [detailOpen, setDetailOpen] = React.useState(false)
  const [detailConfig, setDetailConfig] = React.useState<AiModelConfigResponse | null>(null)

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = pageIndex + 1
  const tableColumnCount = 8

  const cacheRef = React.useRef<Map<string, {
    rows: AiModelConfigResponse[]
    total: number
    updatedAt: number
  }>>(new Map())
  const viewRequestSeqRef = React.useRef(0)
  const refreshStartedAtRef = React.useRef<number>(0)
  const refreshHideTimeoutRef = React.useRef<number | null>(null)
  const refreshMinVisibleMs = 400

  const makeQueryKey = React.useCallback(
    (configType: AiConfigType, pageIndexValue: number) =>
      JSON.stringify({
        configType,
        pageIndex: pageIndexValue,
        pageSize,
        protocolFilter,
        enabledFilter,
        keyword,
      }),
    [enabledFilter, keyword, pageSize, protocolFilter]
  )

  const buildListRequest = React.useCallback(
    (configType: AiConfigType, pageIndexValue: number) => ({
      pageNum: pageIndexValue + 1,
      pageSize,
      orderByColumn: "updatedAt",
      isAsc: "desc",
      configType,
      protocol: protocolFilter === "ALL" ? undefined : protocolFilter,
      enabled: enabledFilter === "ALL" ? undefined : enabledFilter === "true",
      keyword: keyword ? keyword : undefined,
    }),
    [enabledFilter, keyword, pageSize, protocolFilter]
  )

  const fetchAndApply = React.useCallback(
    async (
      configType: AiConfigType,
      pageIndexValue: number,
      options?: {
        showLoading?: boolean
        showRefreshing?: boolean
      }
    ) => {
      const requestId = ++viewRequestSeqRef.current
      if (options?.showLoading) {
        setIsLoading(true)
      }
      if (options?.showRefreshing) {
        if (refreshHideTimeoutRef.current !== null) {
          window.clearTimeout(refreshHideTimeoutRef.current)
          refreshHideTimeoutRef.current = null
        }
        refreshStartedAtRef.current = Date.now()
        setIsRefreshing(true)
      }
      try {
        const res = await aiModelConfigApi.list(buildListRequest(configType, pageIndexValue))
        const nextRows = res.data.rows || []
        const nextTotal = res.data.total || 0
        const key = makeQueryKey(configType, pageIndexValue)
        cacheRef.current.set(key, { rows: nextRows, total: nextTotal, updatedAt: Date.now() })

        if (requestId !== viewRequestSeqRef.current) {
          return
        }

        if (configType === activeType && pageIndexValue === pageIndex) {
          setRows(nextRows)
          setTotal(nextTotal)
        }
      } catch (error) {
        console.error("Failed to fetch model configs:", error)
        toast.error("加载模型配置失败")
      } finally {
        if (requestId === viewRequestSeqRef.current) {
          if (options?.showLoading) {
            setIsLoading(false)
          }
          if (options?.showRefreshing) {
            const elapsed = Date.now() - refreshStartedAtRef.current
            const remaining = refreshMinVisibleMs - elapsed
            if (remaining > 0) {
              refreshHideTimeoutRef.current = window.setTimeout(() => {
                if (requestId === viewRequestSeqRef.current) {
                  setIsRefreshing(false)
                }
                refreshHideTimeoutRef.current = null
              }, remaining)
            } else {
              setIsRefreshing(false)
            }
          }
        }
      }
    },
    [activeType, buildListRequest, makeQueryKey, pageIndex]
  )

  const reloadCurrent = React.useCallback(async () => {
    await fetchAndApply(activeType, pageIndex, { showRefreshing: true })
  }, [activeType, fetchAndApply, pageIndex])

  React.useEffect(() => {
    const key = makeQueryKey(activeType, pageIndex)
    const cached = cacheRef.current.get(key)
    if (cached) {
      setRows(cached.rows)
      setTotal(cached.total)
      setIsLoading(false)
      return
    }
    void fetchAndApply(activeType, pageIndex, { showLoading: true })
  }, [activeType, fetchAndApply, makeQueryKey, pageIndex])

  React.useEffect(() => {
    return () => {
      if (refreshHideTimeoutRef.current !== null) {
        window.clearTimeout(refreshHideTimeoutRef.current)
        refreshHideTimeoutRef.current = null
      }
    }
  }, [])

  React.useEffect(() => {
    if (pageIndex > totalPages - 1) {
      setPageIndex(totalPages - 1)
    }
  }, [pageIndex, totalPages])

  const handlePageChange = React.useCallback(
    (nextPageIndex: number) => {
      if (nextPageIndex < 0 || nextPageIndex >= totalPages) return
      setPageIndex(nextPageIndex)
    },
    [totalPages],
  )

  const resetForm = React.useCallback(() => {
    setName("")
    setProtocol("OPENAI")
    setModel("")
    setBaseUrl("")
    setApiKey("")
    setApiKeyClear(false)
    setEnabled(true)
    setIsDefaultOnCreate(false)
    setExtraJson("")
  }, [])

  const openCreate = React.useCallback(() => {
    setEditorMode("create")
    setActiveConfig(null)
    resetForm()
    setEditorOpen(true)
  }, [activeType, resetForm])

  const openEdit = React.useCallback((config: AiModelConfigResponse) => {
    setEditorMode("edit")
    setActiveConfig(config)
    setName(config.name || "")
    setProtocol(config.protocol)
    setModel(config.model || "")
    setBaseUrl(config.baseUrl || "")
    setApiKey("")
    setApiKeyClear(false)
    setEnabled(Boolean(config.enabled))
    setIsDefaultOnCreate(false)
    setExtraJson(config.extraJson || "")
    setEditorOpen(true)
  }, [])

  const openDetail = React.useCallback((config: AiModelConfigResponse) => {
    setDetailConfig(config)
    setDetailOpen(true)
  }, [])

  const submit = React.useCallback(async () => {
    const trimmedName = safeTrim(name)
    const trimmedModel = safeTrim(model)
    const trimmedBaseUrl = safeTrim(baseUrl)
    const trimmedExtraJson = safeTrim(extraJson)
    const trimmedApiKey = safeTrim(apiKey)

    if (!trimmedName) {
      toast.error("配置名称不能为空")
      return
    }
    if (!trimmedModel) {
      toast.error("模型名称不能为空")
      return
    }

    if (trimmedExtraJson) {
      try {
        JSON.parse(trimmedExtraJson)
      } catch {
        toast.error("扩展参数不是合法 JSON")
        return
      }
    }

    if (saving) return
    setSaving(true)
    try {
      if (editorMode === "create") {
        const req: AiModelConfigCreateRequest = {
          configType: activeType,
          protocol,
          name: trimmedName,
          model: trimmedModel,
          baseUrl: trimmedBaseUrl ? trimmedBaseUrl : undefined,
          apiKey: trimmedApiKey ? trimmedApiKey : undefined,
          enabled,
          isDefault: isDefaultOnCreate,
          extraJson: trimmedExtraJson ? trimmedExtraJson : undefined,
        }
        await aiModelConfigApi.create(req)
        toast.success("配置已创建")
      } else if (activeConfig) {
        const req: AiModelConfigUpdateRequest = {
          id: activeConfig.id,
          protocol,
          name: trimmedName,
          model: trimmedModel,
          baseUrl: safeTrim(baseUrl),
          enabled,
          extraJson: safeTrim(extraJson),
        }

        if (apiKeyClear) {
          req.apiKey = ""
        } else if (trimmedApiKey) {
          req.apiKey = trimmedApiKey
        }

        await aiModelConfigApi.update(req)
        toast.success("配置已更新")
      }

      setEditorOpen(false)
      await reloadCurrent()
    } catch (e: unknown) {
      const msg = (() => {
        if (typeof e === "object" && e && "response" in e) {
          const response = (e as { response?: { data?: { msg?: unknown } } })
            .response
          const apiMsg = response?.data?.msg
          if (typeof apiMsg === "string" && apiMsg) {
            return apiMsg
          }
        }
        if (e instanceof Error && e.message) return e.message
        return "操作失败"
      })()
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }, [
    activeConfig,
    activeType,
    apiKey,
    apiKeyClear,
    baseUrl,
    editorMode,
    enabled,
    extraJson,
    isDefaultOnCreate,
    model,
    name,
    protocol,
    reloadCurrent,
    saving,
  ])

  const confirmDelete = React.useCallback(async () => {
    if (!activeConfig) return
    if (saving) return
    setSaving(true)
    try {
      await aiModelConfigApi.delete({ id: activeConfig.id })
      toast.success("配置已删除")
      setDeleteOpen(false)
      setEditorOpen(false)
      await reloadCurrent()
    } catch (e: unknown) {
      const msg = (() => {
        if (typeof e === "object" && e && "response" in e) {
          const response = (e as { response?: { data?: { msg?: unknown } } })
            .response
          const apiMsg = response?.data?.msg
          if (typeof apiMsg === "string" && apiMsg) {
            return apiMsg
          }
        }
        if (e instanceof Error && e.message) return e.message
        return "删除失败"
      })()
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }, [activeConfig, reloadCurrent, saving])

  const setDefault = React.useCallback(
    async (config: AiModelConfigResponse) => {
      if (saving) return
      setSaving(true)
      try {
        await aiModelConfigApi.setDefault({ id: config.id })
        toast.success("默认配置已更新")
        await reloadCurrent()
      } catch (e: unknown) {
        const msg = (() => {
          if (typeof e === "object" && e && "response" in e) {
            const response = (e as { response?: { data?: { msg?: unknown } } })
              .response
            const apiMsg = response?.data?.msg
            if (typeof apiMsg === "string" && apiMsg) {
              return apiMsg
            }
          }
          if (e instanceof Error && e.message) return e.message
          return "设置默认失败"
        })()
        toast.error(msg)
      } finally {
        setSaving(false)
      }
    },
    [reloadCurrent, saving]
  )

  const clearFilters = React.useCallback(() => {
    setProtocolFilter("ALL")
    setEnabledFilter("ALL")
    setKeywordInput("")
    setKeyword("")
    setPageIndex(0)
  }, [])

  const applyKeyword = React.useCallback(() => {
    setKeyword(safeTrim(keywordInput))
    setPageIndex(0)
  }, [keywordInput])

  return (
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <BrainCircuit className="size-6 text-muted-foreground" />
            模型配置
          </h1>
          <p className="text-sm text-muted-foreground">
            {configTypeLabel(activeType)}：{buildTypeSummary()}
          </p>
        </div>
        <Button onClick={openCreate} className="shrink-0">
          新建配置
        </Button>
      </div>

        <div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:flex-wrap mb-4">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
              <Input
                id="ai-config-keyword"
                value={keywordInput}
                placeholder="搜索配置名称…"
                className="pl-9 pr-9"
                onChange={(e) => setKeywordInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    applyKeyword()
                  }
                }}
              />
              {keywordInput ? (
                <button
                  type="button"
                  onClick={() => { setKeywordInput(""); setKeyword(""); setPageIndex(0) }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="size-4" />
                </button>
              ) : null}
            </div>

            <Select
              value={protocolFilter}
              onValueChange={(v) => {
                if (v === "ALL") {
                  setProtocolFilter("ALL")
                  setPageIndex(0)
                  return
                }
                setProtocolFilter(v as AiProtocol)
                setPageIndex(0)
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="协议类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部协议</SelectItem>
                <SelectItem value="OPENAI">OpenAI</SelectItem>
                <SelectItem value="DEEPSEEK">DeepSeek</SelectItem>
                <SelectItem value="OPENAI_COMPAT">OpenAI 兼容</SelectItem>
                <SelectItem value="SILICONFLOW">SiliconFlow</SelectItem>
                <SelectItem value="GEMINI">Gemini</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={enabledFilter}
              onValueChange={(v) => {
                if (v !== "ALL" && v !== "true" && v !== "false") {
                  return
                }
                setEnabledFilter(v)
                setPageIndex(0)
              }}
            >
              <SelectTrigger className="w-32">
                <SelectValue placeholder="启用状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">全部状态</SelectItem>
                <SelectItem value="true">已启用</SelectItem>
                <SelectItem value="false">已禁用</SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={applyKeyword}>
                查询
              </Button>
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                重置
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void reloadCurrent()}
                disabled={isLoading || isRefreshing}
                className="gap-1.5"
              >
                <Loader2
                  className={cn(
                    "size-3.5 transition-opacity",
                    isRefreshing ? "animate-spin opacity-100" : "opacity-0 w-0"
                  )}
                />
                刷新
              </Button>
            </div>
          </div>

          <div
            className={cn(
              "rounded-2xl border border-neutral-500/10 dark:border-white/10",
              "dark:shadow-[2px_4px_16px_0px_rgba(248,248,248,0.06)_inset]",
              "bg-gray-50 dark:bg-neutral-800/80",
            )}
          >
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[200px]">名称</TableHead>
                  <TableHead className="w-[120px]">协议</TableHead>
                  <TableHead className="w-[220px]">模型</TableHead>
                  <TableHead className="w-[220px]">BaseUrl</TableHead>
                  <TableHead className="w-[140px]">API Key</TableHead>
                  <TableHead className="w-[100px]">状态</TableHead>
                  <TableHead className="w-[180px]">更新时间</TableHead>
                  <TableHead className="w-[72px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: pageSize }, (_, rowIdx) => (
                    <TableRow key={`skeleton-${rowIdx}`} className="animate-pulse">
                      {Array.from({ length: tableColumnCount }, (_, colIdx) => (
                        <TableCell key={`skeleton-${rowIdx}-${colIdx}`}>
                          <div className="h-4 w-full rounded bg-muted/60" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={tableColumnCount} className="py-16 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <BrainCircuit className="size-10 text-muted-foreground/30" />
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-muted-foreground">暂无模型配置</p>
                          <p className="text-xs text-muted-foreground/60">点击右上角「新建配置」添加第一个模型</p>
                        </div>
                        <Button variant="outline" size="sm" onClick={openCreate}>
                          新建配置
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow key={row.id} className="group hover:bg-transparent">
                      <TableCell className="max-w-[200px] rounded-l-xl transition-colors group-hover:bg-muted/50">
                        <div className="flex items-center gap-2 min-w-0">
                          <EllipsisText value={row.name} className="flex-1" />
                          {row.isDefault ? (
                            <Badge variant="default">默认</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[120px] transition-colors group-hover:bg-muted/50">
                        <Badge variant="outline" className={cn("border font-normal", protocolBadgeClass(row.protocol))}>
                          {protocolLabel(row.protocol)}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[220px] transition-colors group-hover:bg-muted/50">
                        <EllipsisText value={row.model} tooltipClassName="break-all" />
                      </TableCell>
                      <TableCell className="max-w-[220px] transition-colors group-hover:bg-muted/50">
                        <EllipsisText
                          value={row.baseUrl || null}
                          tooltipClassName="break-all"
                        />
                      </TableCell>
                      <TableCell className="max-w-[140px] transition-colors group-hover:bg-muted/50">
                        <EllipsisText
                          value={
                            row.hasApiKey ? (row.apiKeyMasked || "已设置") : "未设置"
                          }
                        />
                      </TableCell>
                      <TableCell className="max-w-[100px] transition-colors group-hover:bg-muted/50">
                        {row.enabled ? (
                          <Badge variant="outline" className="border-emerald-200 bg-emerald-500/10 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400 font-normal">启用</Badge>
                        ) : (
                          <Badge variant="secondary" className="font-normal text-muted-foreground">禁用</Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[180px] transition-colors group-hover:bg-muted/50">
                        <EllipsisText value={formatDateTime(row.updatedAt)} />
                      </TableCell>
                      <TableCell className="text-right rounded-r-xl transition-colors group-hover:bg-muted/50">
                        <KbDropdownMenu
                          trigger={
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "h-8 w-8",
                                "data-[state=open]:bg-muted",
                                "transition-opacity",
                                "md:opacity-50 md:group-hover:opacity-100 md:group-focus-within:opacity-100",
                                "data-[state=open]:opacity-100"
                              )}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">打开操作菜单</span>
                            </Button>
                          }
                          align="end"
                        >
                          <DropdownMenuItem
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(row.id)
                                .then(() => toastWithIcon("已复制配置 ID"))
                                .catch(() => toast.error("复制失败"))
                            }}
                          >
                            复制 ID
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              openDetail(row)
                            }}
                          >
                            查看详情
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openEdit(row)}>
                            编辑
                          </DropdownMenuItem>
                          {!row.isDefault ? (
                            <DropdownMenuItem onClick={() => void setDefault(row)}>
                              设为默认
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => {
                              setActiveConfig(row)
                              setDeleteOpen(true)
                            }}
                          >
                            删除
                          </DropdownMenuItem>
                        </KbDropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="py-3 mt-1">
            <AppPagination
              page={pageIndex}
              totalPages={totalPages}
              total={total}
              pageSize={pageSize}
              onChange={handlePageChange}
            />
          </div>
        </div>

      <KbDialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open)
          if (!open) {
            setDetailConfig(null)
          }
        }}
        title="配置详情"
        description={
          detailConfig
            ? `${configTypeLabel(detailConfig.configType)} · ${detailConfig.name}`
            : undefined
        }
        footer={
          <Button type="button" variant="secondary" onClick={() => setDetailOpen(false)}>
            关闭
          </Button>
        }
      >
        {detailConfig ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1 sm:col-span-2">
                <div className="text-sm text-muted-foreground">用途说明</div>
                <div className="text-sm">{buildTypeSummary()}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">配置 ID</div>
                <div className="flex items-center gap-2">
                  <code className="text-sm">{detailConfig.id}</code>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(detailConfig.id)
                        .then(() => toastWithIcon("已复制配置 ID"))
                        .catch(() => toast.error("复制失败"))
                    }}
                  >
                    复制
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">协议</div>
                <div className="text-sm">{protocolLabel(detailConfig.protocol)}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">模型</div>
                <div className="text-sm break-all">{detailConfig.model}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">状态</div>
                <div className="flex items-center gap-2">
                  {detailConfig.enabled ? (
                    <Badge variant="outline">启用</Badge>
                  ) : (
                    <Badge variant="secondary">禁用</Badge>
                  )}
                  {detailConfig.isDefault ? <Badge>默认</Badge> : null}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">API Key</div>
                <div className="text-sm break-all">
                  {detailConfig.hasApiKey
                    ? detailConfig.apiKeyMasked || "已设置（不回显明文）"
                    : "未设置"}
                </div>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <div className="text-sm text-muted-foreground">BaseUrl</div>
                <div className="text-sm break-all">
                  {detailConfig.baseUrl ? detailConfig.baseUrl : "默认 BaseUrl"}
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">创建时间</div>
                <div className="text-sm">{formatDateTime(detailConfig.createdAt)}</div>
              </div>
              <div className="space-y-1">
                <div className="text-sm text-muted-foreground">更新时间</div>
                <div className="text-sm">{formatDateTime(detailConfig.updatedAt)}</div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-sm text-muted-foreground">扩展参数</div>
              <pre className="rounded-md border bg-muted/50 p-3 text-xs whitespace-pre-wrap break-all">
                {formatExtraJson(detailConfig.extraJson)}
              </pre>
              {buildExtraJsonHint() ? (
                <p className="text-xs text-muted-foreground">
                  {buildExtraJsonHint()}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="py-6 text-sm text-muted-foreground">暂无详情</div>
        )}
      </KbDialog>

      <KbDialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setEditorOpen(open)
        }}
        disableClose={saving}
        title={editorMode === "create" ? "新建模型配置" : "编辑模型配置"}
        description={buildEditorDescription()}
        footer={
          <>
            {editorMode === "edit" ? (
              <Button
                type="button"
                variant="destructive"
                disabled={saving || !activeConfig}
                onClick={() => {
                  if (!activeConfig) return
                  setDeleteOpen(true)
                }}
              >
                删除
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setEditorOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={saving} onClick={submit}>
              {saving ? "处理中..." : editorMode === "create" ? "创建" : "保存"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            {buildTypeSummary()}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>协议类型</Label>
              <Select value={protocol} onValueChange={(v) => setProtocol(v as AiProtocol)}>
                <SelectTrigger>
                  <SelectValue placeholder="请选择协议类型" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPENAI">OpenAI</SelectItem>
                  <SelectItem value="DEEPSEEK">DeepSeek</SelectItem>
                  <SelectItem value="OPENAI_COMPAT">OpenAI 兼容</SelectItem>
                  <SelectItem value="SILICONFLOW">SiliconFlow</SelectItem>
                  <SelectItem value="GEMINI">Gemini</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-config-name">配置名称</Label>
              <Input
                id="ai-config-name"
                value={name}
                disabled={saving}
                placeholder="例如：默认问答模型"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">连接配置</p>

            <div className="space-y-2">
              <Label htmlFor="ai-config-model">模型名称</Label>
              <Input
                id="ai-config-model"
                value={model}
                disabled={saving}
                placeholder={buildModelPlaceholder()}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>

          <div className="space-y-2">
            <Label htmlFor="ai-config-baseUrl">BaseUrl（可选）</Label>
            <Input
              id="ai-config-baseUrl"
              value={baseUrl}
              disabled={saving}
              placeholder="例如：https://api.openai.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            {editorMode === "edit" ? (
              <p className="text-xs text-muted-foreground">
                清空后将走服务端默认值
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-config-apiKey">API Key（可选）</Label>
            <Input
              id="ai-config-apiKey"
              value={apiKey}
              disabled={saving || apiKeyClear}
              placeholder={editorMode === "edit" && activeConfig?.hasApiKey
                ? (activeConfig.apiKeyMasked || "已设置（留空表示不修改）")
                : editorMode === "edit"
                  ? "留空表示不修改"
                  : "例如：sk-******"}
              onChange={(e) => setApiKey(e.target.value)}
            />
            {editorMode === "edit" ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {activeConfig?.hasApiKey ? "当前已设置 API Key（不会回显明文）" : "当前未设置 API Key"}
                </p>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={apiKeyClear}
                    onCheckedChange={(checked) => {
                      setApiKeyClear(Boolean(checked))
                      if (checked) {
                        setApiKey("")
                      }
                    }}
                    disabled={saving}
                    aria-label="清空 API Key"
                  />
                  <span className="text-sm">清空</span>
                </div>
              </div>
            ) : null}
          </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
            <div>
              <div className="font-medium">启用</div>
              <div className="text-sm text-muted-foreground">
                关闭后不会被模型调用侧使用
              </div>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => setEnabled(Boolean(checked))}
              disabled={saving}
              aria-label="启用配置"
            />
          </div>

          {editorMode === "create" ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <div className="font-medium">设为默认</div>
                <div className="text-sm text-muted-foreground">
                  创建后将成为该类型的默认配置
                </div>
              </div>
              <Switch
                checked={isDefaultOnCreate}
                onCheckedChange={(checked) => setIsDefaultOnCreate(Boolean(checked))}
                disabled={saving}
                aria-label="设为默认配置"
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="ai-config-extra">扩展参数（JSON，可选）</Label>
            <Textarea
              id="ai-config-extra"
              value={extraJson}
              disabled={saving}
              placeholder={buildExtraJsonPlaceholder()}
              className="min-h-28 font-mono"
              onChange={(e) => setExtraJson(e.target.value)}
            />
            {buildExtraJsonHint() ? (
              <p className="text-xs text-muted-foreground">
                {buildExtraJsonHint()}
              </p>
            ) : null}
          </div>
        </div>
      </KbDialog>

      <KbDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setDeleteOpen(open)
        }}
        disableClose={saving}
        title="确认删除配置？"
        description={
          activeConfig?.name
            ? `将删除“${activeConfig.name}”。`
            : "将删除该配置。"
        }
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setDeleteOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={saving || !activeConfig}
              onClick={confirmDelete}
            >
              {saving ? "删除中..." : "确认删除"}
            </Button>
          </>
        }
      />
    </div>
  )
}

export default AiModelConfigPage
