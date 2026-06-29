"use client"

import * as React from "react"
import {
    AssistantRuntimeProvider,
    AuiIf,
    ComposerPrimitive,
    ErrorPrimitive,
    makeAssistantToolUI,
    MessagePrimitive,
    ThreadPrimitive,
    useAuiState,
    type ToolCallMessagePartStatus,
} from "@assistant-ui/react"
import { AssistantChatTransport, useChatRuntime, type UseChatRuntimeOptions } from "@assistant-ui/react-ai-sdk"
import { useNavigate } from "react-router-dom"
type DocQaMsg = NonNullable<UseChatRuntimeOptions["messages"]>[number]
import {
    ArrowUp,
    Library,
    Loader2,
    MessageSquarePlus,
    Square,
    Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { MarkdownText } from "@/components/assistant-ui/markdown-text"
import { ToolFallback } from "@/components/assistant-ui/tool-fallback"
import { CitationList } from "@/components/tool-ui/citation"
import { safeParseSerializableCitation } from "@/components/tool-ui/citation/schema"
import { DataTable } from "@/components/tool-ui/data-table"
import { safeParseSerializableDataTable } from "@/components/tool-ui/data-table/schema"
import { Plan } from "@/components/tool-ui/plan"
import { safeParseSerializablePlan } from "@/components/tool-ui/plan/schema"
import { ProgressTracker } from "@/components/tool-ui/progress-tracker"
import { safeParseSerializableProgressTracker } from "@/components/tool-ui/progress-tracker/schema"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import {
    docLibraryApi,
    type DocLibrary,
    type DocQaModelInfo,
    type DocQaThreadResponse,
} from "@/lib/api"
import { cn } from "@/lib/utils"

const CHAT_THREAD_HEADER = "X-Petrichor-Agent-Thread-Id"

const PlanToolUI = makeAssistantToolUI({
    toolName: "show_agent_plan",
    render: ({ result, args, status }) => {
        const parsed = safeParseSerializablePlan(result ?? args)
        if (!parsed) return <ToolStatusCard title="执行计划" status={status} />
        return <Plan {...parsed} />
    },
})

const ProgressToolUI = makeAssistantToolUI({
    toolName: "show_progress",
    render: ({ result, args, status }) => {
        const parsed = safeParseSerializableProgressTracker(result ?? args)
        if (!parsed) return <ToolStatusCard title="执行进度" status={status} />
        return <ProgressTracker {...parsed} />
    },
})

const CitationToolUI = makeAssistantToolUI({
    toolName: "show_citations",
    render: ({ result, args, status }) => <CitationToolRender result={result} args={args} status={status} />,
})

function CitationToolRender({ result, args, status }: { result: unknown; args: unknown; status?: ToolCallMessagePartStatus }) {
    const navigate = useNavigate()
    const payload = asRecord(result ?? args)
    const citations = Array.isArray(payload?.citations)
        ? payload.citations.map((item) => safeParseSerializableCitation(item)).filter(isPresent)
        : []
    const handleNavigate = React.useCallback((href: string) => {
        if (href.startsWith("/")) {
            navigate(href)
            return
        }
        if (typeof window !== "undefined") window.open(href, "_blank", "noopener,noreferrer")
    }, [navigate])
    if (citations.length === 0) return <ToolStatusCard title="引用来源" status={status} />
    return (
        <CitationList
            id={String(payload?.id ?? "citations")}
            citations={citations}
            variant="default"
            onNavigate={handleNavigate}
        />
    )
}

const DataTableToolUI = makeAssistantToolUI({
    toolName: "show_data_table",
    render: ({ result, args, status }) => {
        const payload = asRecord(result ?? args)
        const parsed = safeParseSerializableDataTable(payload)
        if (!parsed) return <ToolStatusCard title="结构化表格" status={status} />
        return (
            <div className="space-y-2">
                {typeof payload?.title === "string" && payload.title ? (
                    <p className="text-sm font-medium">{payload.title}</p>
                ) : null}
                <DataTable {...parsed} />
            </div>
        )
    },
})

function ToolStatusCard({ title, status }: { title: string; status?: ToolCallMessagePartStatus }) {
    const running = status?.type === "running"
    return (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {running ? <Loader2 className="size-3.5 animate-spin" /> : <Library className="size-3.5" />}
            <span>{title}</span>
        </div>
    )
}

export function DocLibraryQaPage() {
    const [threads, setThreads] = React.useState<DocQaThreadResponse[]>([])
    const [threadsLoading, setThreadsLoading] = React.useState(true)
    const [libraries, setLibraries] = React.useState<DocLibrary[]>([])
    const [modelInfo, setModelInfo] = React.useState<DocQaModelInfo | null>(null)
    const [selectedConfigId, setSelectedConfigId] = React.useState<string | null>(null)
    const [scopeLibraryId, setScopeLibraryId] = React.useState<string | null>(null)
    const [activeThreadId, setActiveThreadId] = React.useState<string | null>(null)
    const [initialMessages, setInitialMessages] = React.useState<DocQaMsg[]>([])
    const [runtimeSeed, setRuntimeSeed] = React.useState(0)

    const refreshThreads = React.useCallback(async () => {
        setThreadsLoading(true)
        try {
            const res = await docLibraryApi.threadList({ limit: 50 })
            setThreads(res.data.threads)
        } catch (error) {
            toast.error(resolveApiErrorMessage(error, "加载对话失败"))
        } finally {
            setThreadsLoading(false)
        }
    }, [])

    React.useEffect(() => {
        void refreshThreads()
        docLibraryApi.listLibraries().then((res) => setLibraries(res.data.libraries)).catch(() => undefined)
        docLibraryApi.modelInfo()
            .then((res) => {
                setModelInfo(res.data)
                setSelectedConfigId((current) => current ?? res.data.configId)
            })
            .catch(() => setModelInfo(null))
    }, [refreshThreads])

    const loadThread = React.useCallback(async (threadId: string) => {
        try {
            const res = await docLibraryApi.threadDetail(threadId)
            setActiveThreadId(res.data.thread.id)
            setScopeLibraryId(res.data.thread.libraryId)
            setInitialMessages(toInitialMessages(res.data.messages))
            setRuntimeSeed((v) => v + 1)
        } catch (error) {
            toast.error(resolveApiErrorMessage(error, "加载对话失败"))
        }
    }, [])

    const handleNewThread = React.useCallback(() => {
        setActiveThreadId(null)
        setInitialMessages([])
        setRuntimeSeed((v) => v + 1)
    }, [])

    const handleDeleteThread = React.useCallback(async (threadId: string) => {
        try {
            await docLibraryApi.threadDelete(threadId)
            setThreads((items) => items.filter((item) => item.id !== threadId))
            if (activeThreadId === threadId) handleNewThread()
            toast.success("已删除对话")
        } catch (error) {
            toast.error(resolveApiErrorMessage(error, "删除失败"))
        }
    }, [activeThreadId, handleNewThread])

    const handleThreadKnown = React.useCallback((threadId: string) => {
        setActiveThreadId((current) => {
            if (current === threadId) return current
            void refreshThreads()
            return threadId
        })
    }, [refreshThreads])

    const handleScopeChange = React.useCallback((value: string) => {
        const next = value === "all" ? null : value
        setScopeLibraryId(next)
        if (activeThreadId) handleNewThread()
    }, [activeThreadId, handleNewThread])

    return (
        <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 w-full">
            <aside className="flex w-72 shrink-0 flex-col border-r border-border/60 bg-muted/20">
                <div className="flex h-12 items-center justify-between px-3">
                    <span className="text-[13px] font-semibold">文档问答</span>
                    <Button variant="ghost" size="icon" className="size-7" onClick={handleNewThread}>
                        <MessageSquarePlus className="size-4" />
                    </Button>
                </div>
                <ScrollArea className="min-h-0 flex-1">
                    <div className="px-2 pb-4">
                        {threadsLoading ? (
                            <div className="flex justify-center py-6 text-muted-foreground">
                                <Loader2 className="size-4 animate-spin" />
                            </div>
                        ) : threads.length === 0 ? (
                            <p className="px-2 py-6 text-center text-xs text-muted-foreground">还没有对话</p>
                        ) : (
                            threads.map((thread) => (
                                <div
                                    key={thread.id}
                                    className={cn(
                                        "group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
                                        activeThreadId === thread.id ? "bg-accent" : "hover:bg-accent/50",
                                    )}
                                >
                                    <button
                                        type="button"
                                        className="min-w-0 flex-1 truncate text-left"
                                        onClick={() => loadThread(thread.id)}
                                    >
                                        {thread.title}
                                    </button>
                                    <button
                                        type="button"
                                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                                        onClick={() => handleDeleteThread(thread.id)}
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </ScrollArea>
            </aside>

            <main className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-12 items-center gap-3 border-b border-border/60 px-4">
                    <span className="text-xs text-muted-foreground">问答范围</span>
                    <Select value={scopeLibraryId ?? "all"} onValueChange={handleScopeChange}>
                        <SelectTrigger className="h-8 w-48 text-xs">
                            <SelectValue placeholder="全部文档库" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">全部文档库</SelectItem>
                            {libraries.map((library) => (
                                <SelectItem key={library.id} value={library.id}>{library.name}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {modelInfo?.availableModels && modelInfo.availableModels.length > 0 ? (
                        <Select value={selectedConfigId ?? undefined} onValueChange={setSelectedConfigId}>
                            <SelectTrigger className="h-8 w-52 text-xs">
                                <SelectValue placeholder="选择模型" />
                            </SelectTrigger>
                            <SelectContent>
                                {modelInfo.availableModels.map((model) => (
                                    <SelectItem key={model.configId} value={model.configId}>
                                        {model.modelName}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    ) : null}
                </div>

                <div className="min-h-0 flex-1">
                    {modelInfo && modelInfo.configId == null ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                            <p>还没有配置「文档库问答（Doc QA）」模型。</p>
                            <p>请到「模型配置」新增一个 DOC_QA 配置并设为默认。</p>
                        </div>
                    ) : (
                        <ChatPanel
                            key={runtimeSeed}
                            libraryId={scopeLibraryId}
                            threadId={activeThreadId}
                            initialMessages={initialMessages}
                            selectedConfigId={selectedConfigId}
                            onThreadKnown={handleThreadKnown}
                            onStreamSettled={refreshThreads}
                        />
                    )}
                </div>
            </main>
        </div>
    )
}

function ChatPanel({
    libraryId,
    threadId,
    initialMessages,
    selectedConfigId,
    onThreadKnown,
    onStreamSettled,
}: {
    libraryId: string | null
    threadId: string | null
    initialMessages: DocQaMsg[]
    selectedConfigId: string | null
    onThreadKnown: (threadId: string) => void
    onStreamSettled: () => void | Promise<void>
}) {
    const configIdRef = React.useRef(selectedConfigId)
    React.useEffect(() => {
        configIdRef.current = selectedConfigId
    }, [selectedConfigId])

    const transport = React.useMemo(() => new AssistantChatTransport<DocQaMsg>({
        api: "/api/doc-library/chat",
        body: { libraryId, threadId },
        credentials: "include",
        fetch: async (input, init) => {
            const currentConfigId = configIdRef.current
            let nextInit = init
            if (currentConfigId && init && typeof init.body === "string") {
                try {
                    const parsed = JSON.parse(init.body)
                    if (parsed && typeof parsed === "object") {
                        parsed.configId = currentConfigId
                        nextInit = { ...init, body: JSON.stringify(parsed) }
                    }
                } catch {
                    // 非 JSON body 时保持原样
                }
            }
            const response = await fetch(input, nextInit)
            if (response.status === 401 && typeof window !== "undefined") {
                const redirect = encodeURIComponent(window.location.pathname + window.location.search)
                window.location.replace(`/login?redirect=${redirect}`)
            }
            const remoteThreadId = response.headers.get(CHAT_THREAD_HEADER)
            if (remoteThreadId) onThreadKnown(remoteThreadId)
            return response
        },
    }), [libraryId, threadId, onThreadKnown])

    const runtime = useChatRuntime({
        id: threadId ?? `doc-qa-${libraryId ?? "all"}-draft`,
        messages: initialMessages,
        transport,
        onFinish: () => {
            void onStreamSettled()
        },
    })

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <PlanToolUI />
            <ProgressToolUI />
            <CitationToolUI />
            <DataTableToolUI />
            <ThreadPrimitive.Root className="flex h-full flex-col bg-background px-4">
                <AuiIf condition={(s) => s.thread.isEmpty}>
                    <div className="flex h-full flex-col items-center justify-center gap-4">
                        <div className="text-center">
                            <h2 className="text-xl font-semibold">基于文档库内容提问</h2>
                            <p className="mt-1 text-sm text-muted-foreground">
                                我会在文档库里检索相关内容并给出带来源的回答。
                            </p>
                        </div>
                        <Composer placeholder="在文档库里问点什么？" />
                    </div>
                </AuiIf>
                <AuiIf condition={(s) => s.thread.isEmpty === false}>
                    <ThreadPrimitive.Viewport className="flex grow flex-col overflow-y-auto pt-8">
                        <ThreadPrimitive.Messages>
                            {() => <ChatMessage />}
                        </ThreadPrimitive.Messages>
                    </ThreadPrimitive.Viewport>
                    <Composer placeholder="继续提问…" />
                    <p className="mx-auto w-full max-w-3xl pb-2 text-center text-xs text-muted-foreground">
                        回答由 AI 基于文档库内容生成，请自行核验关键信息。
                    </p>
                </AuiIf>
            </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
    )
}

function ChatMessage() {
    return (
        <MessagePrimitive.Root className="mx-auto mb-4 flex w-full max-w-3xl flex-col">
            <AuiIf condition={(s) => s.message.role === "user"}>
                <div className="flex justify-end">
                    <div className="max-w-[90%] rounded-3xl rounded-br-lg bg-muted px-4 py-2.5 text-foreground">
                        <div className="prose prose-sm dark:prose-invert prose-p:my-0">
                            <MessagePrimitive.Parts>
                                {({ part }) => (part.type === "text" ? <MarkdownText /> : null)}
                            </MessagePrimitive.Parts>
                        </div>
                    </div>
                </div>
            </AuiIf>
            <AuiIf condition={(s) => s.message.role === "assistant"}>
                <div className="prose prose-sm max-w-none dark:prose-invert">
                    <MessagePrimitive.Parts>
                        {({ part }) => {
                            if (part.type === "text") return <MarkdownText />
                            if (part.type === "tool-call") {
                                return <div className="not-prose my-3">{part.toolUI ?? <ToolFallback {...part} />}</div>
                            }
                            return null
                        }}
                    </MessagePrimitive.Parts>
                    <MessagePrimitive.Error>
                        <ErrorPrimitive.Root className="mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
                            <ErrorPrimitive.Message className="line-clamp-2" />
                        </ErrorPrimitive.Root>
                    </MessagePrimitive.Error>
                </div>
            </AuiIf>
        </MessagePrimitive.Root>
    )
}

function Composer({ placeholder }: { placeholder: string }) {
    const isEmpty = useAuiState((s) => s.composer.isEmpty)
    const isRunning = useAuiState((s) => s.thread.isRunning)
    return (
        <ComposerPrimitive.Root className="mx-auto mb-3 w-full max-w-3xl">
            <div className="flex items-end gap-2 rounded-[24px] border bg-background p-2 shadow-sm focus-within:border-ring">
                <ComposerPrimitive.Input
                    name="message"
                    placeholder={placeholder}
                    minRows={1}
                    className="my-1.5 ml-2 max-h-60 min-w-0 flex-1 resize-none bg-transparent text-base leading-6 outline-none"
                />
                {isRunning ? (
                    <ComposerPrimitive.Cancel className="flex size-9 items-center justify-center rounded-full bg-foreground text-background">
                        <Square className="size-3.5 fill-current" />
                    </ComposerPrimitive.Cancel>
                ) : (
                    <ComposerPrimitive.Send
                        disabled={isEmpty}
                        className="flex size-9 items-center justify-center rounded-full bg-foreground text-background disabled:opacity-40"
                    >
                        <ArrowUp className="size-[18px]" />
                    </ComposerPrimitive.Send>
                )}
            </div>
        </ComposerPrimitive.Root>
    )
}

// ===== helpers =====

function toInitialMessages(messages: Array<{ id: string; role: string; contentText: string; content?: unknown }>): DocQaMsg[] {
    return messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => {
            const savedParts = extractPersistedParts(message.content)
            const parts = savedParts ?? [{ type: "text", text: message.contentText || "" }]
            return { id: `persisted-${message.id}`, role: message.role, parts }
        }) as DocQaMsg[]
}

function extractPersistedParts(content: unknown) {
    const record = asRecord(content)
    if (!record) return null
    const parts = record.parts
    if (!Array.isArray(parts) || parts.length === 0) return null
    const sanitized = parts.map((part) => sanitizeDocQaMsgPart(part)).filter((part): part is Record<string, unknown> => part != null)
    return sanitized.length > 0 ? sanitized : null
}

function sanitizeDocQaMsgPart(part: unknown): Record<string, unknown> | null {
    const record = asRecord(part)
    if (!record) return null
    const type = typeof record.type === "string" ? record.type : ""
    if (!type) return null
    if (type === "text" || type === "reasoning") {
        if (typeof record.text !== "string") return null
        return { type, text: record.text }
    }
    if (type === "step-start") return { type }
    if (type.startsWith("tool-") || type === "dynamic-tool") {
        const next: Record<string, unknown> = { ...record }
        const state = typeof record.state === "string" ? record.state : ""
        if (state === "input-streaming" || state === "input-available" || !state) {
            next.state = "output-available"
        }
        if (next.output === undefined && next.result !== undefined) next.output = next.result
        return next
    }
    return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isPresent<T>(value: T | null | undefined): value is T {
    return value != null
}

function resolveApiErrorMessage(error: unknown, fallback: string): string {
    const data = (error as { response?: { data?: { msg?: string } } })?.response?.data
    return data?.msg || (error instanceof Error ? error.message : fallback) || fallback
}
