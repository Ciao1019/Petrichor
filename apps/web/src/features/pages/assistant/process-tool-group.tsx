"use client"

import * as React from "react"
import { ChatToolCalls, type ChatToolCallStatus } from "@astryxdesign/core/Chat"
import { useAuiState, type ToolCallMessagePartStatus } from "@assistant-ui/react"
import { ChevronDown } from "@/components/iconimate"

import { AstryxProvider } from "@/components/astryx/astryx-provider"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

import { asRecord, asRows, isPresent } from "./assistant-message-utils"

/**
 * 「过程类」工具：单条结果只够说一句话（读了哪篇、列了几个），
 * 不值得各占一张 130px 的卡。这些工具在消息流里合并成一段过程日志，
 * 由该组第一条调用（leader）统一渲染，其余返回 null。
 *
 * 承载回答内容的工具（引用、表格、计划、确认）不在此列——它们是结果不是过程。
 */
export const PROCESS_TOOL_NAMES = new Set([
  "read_knowledge_node",
  "read_document",
  "save_answer_artifact",
  "list_knowledge_bases",
  "list_doc_libraries",
  "list_system_overview",
  "read_wiki_page_detail",
])

/** 超过这个步数默认收起，避免长检索把回答顶下去 */
const AUTO_COLLAPSE_THRESHOLD = 3

type ProcessDetail =
  | { kind: "names"; items: string[] }
  | { kind: "overview"; rows: [string, string][] }

type ProcessCall = {
  toolCallId: string
  status: ChatToolCallStatus
  /** 中文动作名，渲染在行首 */
  label: string
  /** 动作对象（文章标题、数量等） */
  target?: string
  /** 跟在对象后面的补充信息（类型、定位符） */
  stats?: string
  detail?: ProcessDetail
}

type ClusterSnapshot = {
  isLeader: boolean
  calls: ProcessCall[]
}

function toChatStatus(status?: ToolCallMessagePartStatus): ChatToolCallStatus {
  switch (status?.type) {
    case "running":
      return "running"
    case "requires-action":
      return "pending"
    case "incomplete":
      return "error"
    default:
      return "complete"
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function namesOf(rows: Record<string, unknown>[]): string[] {
  return rows
    .map((row) => firstString(row.name, row.title))
    .filter(isPresent)
}

/**
 * 把一次工具调用压成一行。返回的对象必须是可 JSON 序列化的小结构——
 * 整个 cluster 每次 message 状态变化都会重新序列化，不能把
 * read_document 的全文正文这类大 payload 带进来。
 */
function describeCall(
  toolName: string,
  result: unknown,
  status?: ToolCallMessagePartStatus,
): Omit<ProcessCall, "toolCallId"> {
  const chatStatus = toChatStatus(status)
  const payload = asRecord(result)

  switch (toolName) {
    case "read_knowledge_node": {
      return {
        status: chatStatus,
        label: "阅读知识",
        target: firstString(payload?.title) ?? "知识节点",
        stats: firstString(payload?.kind),
      }
    }
    case "read_wiki_page_detail": {
      return {
        status: chatStatus,
        label: "阅读 Wiki",
        target: firstString(payload?.title, payload?.pageKey) ?? "Wiki 页面",
        stats: firstString(payload?.kind),
      }
    }
    case "read_document": {
      const locator = payload?.locator ?? payload?.fromIndex
      return {
        status: chatStatus,
        label: "阅读文档",
        target: firstString(payload?.title, payload?.fileName) ?? "文档",
        stats: locator != null ? String(locator) : undefined,
      }
    }
    case "save_answer_artifact": {
      return {
        status: chatStatus,
        label: "保存产物",
        target: firstString(payload?.title) ?? "回答产物",
        stats: firstString(payload?.kind, payload?.artifactType) ?? "artifact",
      }
    }
    case "list_knowledge_bases": {
      const names = namesOf(
        Array.isArray(result) ? result.map(asRecord).filter(isPresent) : asRows(result, "knowledgeBases"),
      )
      return {
        status: chatStatus,
        label: "读取知识库",
        target: `${names.length} 个`,
        detail: names.length > 0 ? { kind: "names", items: names } : undefined,
      }
    }
    case "list_doc_libraries": {
      const names = namesOf(
        Array.isArray(result) ? result.map(asRecord).filter(isPresent) : asRows(result, "libraries"),
      )
      return {
        status: chatStatus,
        label: "读取文档库",
        target: `${names.length} 个`,
        detail: names.length > 0 ? { kind: "names", items: names } : undefined,
      }
    }
    case "list_system_overview": {
      const num = (key: string) => Number(payload?.[key] ?? 0)
      const rows: [string, string][] = [
        ["知识库", String(num("knowledgeBases"))],
        ["文章", String(num("articles"))],
        ["文档库", String(num("docLibraries"))],
        ["文档", String(num("documents"))],
        ["对话", String(num("assistantThreads"))],
        ["模型", `CHAT ${payload?.chatModelReady ? "就绪" : "未配"} · EMBED ${payload?.embeddingModelReady ? "就绪" : "未配"}`],
      ]
      return {
        status: chatStatus,
        label: "系统概览",
        target: `知识库 ${num("knowledgeBases")} · 文章 ${num("articles")}`,
        detail: { kind: "overview", rows },
      }
    }
    default:
      return { status: chatStatus, label: toolName }
  }
}

/**
 * 找出当前调用所属的「连续过程工具」区间。
 * 与 search-tool-ui 的 useSearchCluster 同一套 leader 模式，区别是
 * 这里按「是否属于过程类工具」聚合，而非按同名工具聚合，
 * 因此读知识 / 读文档 / 列知识库混排时也能并进同一段。
 */
function useProcessCluster(toolCallId: string): ClusterSnapshot {
  const snapshot = useAuiState((state) => {
    const parts = state.message.parts
    const isProcessPart = (index: number) => {
      const part = parts[index]
      return (
        part?.type === "tool-call"
        && PROCESS_TOOL_NAMES.has((part as { toolName?: string }).toolName ?? "")
      )
    }

    const myIndex = parts.findIndex(
      (part) => part.type === "tool-call" && part.toolCallId === toolCallId,
    )
    if (myIndex < 0) return JSON.stringify({ isLeader: true, calls: [] })

    let start = myIndex
    let end = myIndex
    while (start > 0 && isProcessPart(start - 1)) start -= 1
    while (end < parts.length - 1 && isProcessPart(end + 1)) end += 1

    const calls: ProcessCall[] = []
    for (let index = start; index <= end; index += 1) {
      const part = parts[index]
      if (part?.type !== "tool-call") continue
      const toolPart = part as {
        toolCallId: string
        toolName: string
        result?: unknown
        status?: ToolCallMessagePartStatus
      }
      const status = toolPart.status
        ?? (toolPart.result != null ? { type: "complete" as const } : { type: "running" as const })
      calls.push({
        toolCallId: toolPart.toolCallId,
        ...describeCall(toolPart.toolName, toolPart.result, status),
      })
    }

    const leader = parts[start]
    return JSON.stringify({
      isLeader: leader?.type === "tool-call" && leader.toolCallId === toolCallId,
      calls,
    })
  })
  return React.useMemo(() => JSON.parse(snapshot) as ClusterSnapshot, [snapshot])
}

function DetailBody({ detail }: { detail: ProcessDetail }) {
  if (detail.kind === "names") {
    return (
      <div className="flex flex-wrap gap-1.5 pt-1">
        {detail.items.map((name, index) => (
          <Badge key={`${name}-${index}`} variant="secondary" className="font-normal">
            {name}
          </Badge>
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground sm:grid-cols-3">
      {detail.rows.map(([label, value]) => (
        <div key={label}>
          {label} <span className="font-medium text-foreground">{value}</span>
        </div>
      ))}
    </div>
  )
}

function CallRows({ calls }: { calls: ProcessCall[] }) {
  return (
    <AstryxProvider>
      {/* 逐条渲染：ChatToolCalls 在 calls.length === 1 时走无外框的内联分支。
          整组传入会命中它 v0.1.8 里硬编码的英文分组头 "N tool calls"，
          且 label prop 声明了却未实现，无法覆盖——所以分组头由外层自己出。 */}
      {calls.map((call) => (
        <ChatToolCalls
          key={call.toolCallId}
          calls={[
            {
              key: call.toolCallId,
              name: call.label,
              target: call.target,
              status: call.status,
              stats: call.stats,
              resultDetail: call.detail ? <DetailBody detail={call.detail} /> : undefined,
            },
          ]}
        />
      ))}
    </AstryxProvider>
  )
}

/**
 * 过程日志组。挂在该组第一条调用上，非 leader 返回 null。
 */
export function ProcessToolGroup({ toolCallId }: { toolCallId: string }) {
  const { isLeader, calls } = useProcessCluster(toolCallId)
  if (!isLeader || calls.length === 0) return null

  if (calls.length === 1) return <CallRows calls={calls} />

  return <ProcessGroupShell calls={calls} />
}

function ProcessGroupShell({ calls }: { calls: ProcessCall[] }) {
  const running = calls.some((call) => call.status === "running" || call.status === "pending")
  const [open, setOpen] = React.useState(true)
  /* Collapsible 的 defaultOpen 只在挂载时读一次，而这一组是流式长出来的
     （挂载时只有 1 步），所以自动收起必须受控：跑的时候摊开看进度，
     收尾时步数超阈值再折起来。用户手动开合过就不再自动干预。 */
  const userToggled = React.useRef(false)
  const autoCollapsed = React.useRef(false)

  React.useEffect(() => {
    if (running || userToggled.current || autoCollapsed.current) return
    if (calls.length > AUTO_COLLAPSE_THRESHOLD) {
      autoCollapsed.current = true
      setOpen(false)
    }
  }, [running, calls.length])

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        userToggled.current = true
        setOpen(next)
      }}
    >
      <CollapsibleTrigger className="group/ptg flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
        <ChevronDown className="size-3 transition-transform duration-200 group-data-[state=closed]/ptg:-rotate-90" />
        {running ? "检索中" : "检索过程"} · {calls.length} 步
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:hidden">
        <CallRows calls={calls} />
      </CollapsibleContent>
    </Collapsible>
  )
}
