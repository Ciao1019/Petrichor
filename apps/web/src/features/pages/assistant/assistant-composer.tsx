"use client"

import * as React from "react"
import {
  ComposerPrimitive,
  useAuiState,
} from "@assistant-ui/react"
import {
  ArrowUp,
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  Globe2,
  Library,
  MessageCircleQuestion,
  Square,
} from "@/components/iconimate"

import { ContextDisplay } from "@/components/assistant-ui/context-display"
import { useThreadTokenUsage } from "@assistant-ui/react-ai-sdk"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { GsapFade } from "@/components/ui/gsap-transition"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  type DocLibrary,
  type KnowledgeBaseQaModelInfo,
  type KnowledgeBaseQaModelOption,
  type KnowledgeBaseQaSummary,
} from "@/lib/api"
import { gsap } from "@/lib/gsap"
import { cn } from "@/lib/utils"

import {
  type AssistantFocusSelection,
  formatContextWindow,
} from "./assistant-message-utils"
import {
  ComposerAddAttachment,
  ComposerAttachments,
} from "@/components/assistant-ui/attachment"

export function GrokComposer({
  placeholder,
  knowledgeBases,
  docLibraries,
  focusSelection,
  onFocusChange,
  scopeLabel,
  qaMode,
  onQaModeChange,
  modelInfo,
  selectedConfigId,
  onConfigChange,
  onComposerFocus,
}: {
  placeholder: string
  knowledgeBases: KnowledgeBaseQaSummary[]
  docLibraries: DocLibrary[]
  focusSelection: AssistantFocusSelection
  onFocusChange: (next: AssistantFocusSelection) => void
  scopeLabel: string
  qaMode: "normal" | "wiki"
  onQaModeChange: (next: "normal" | "wiki") => void
  modelInfo: KnowledgeBaseQaModelInfo | null
  selectedConfigId: string | null
  onConfigChange: (next: string) => void
  onComposerFocus?: () => void
}) {
  const isEmpty = useAuiState((s) => s.composer.isEmpty)
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const contextWindow = modelInfo?.contextWindow ?? null
  const availableModels = modelInfo?.availableModels ?? []

  return (
    <ComposerPrimitive.Root
      className="group/composer mx-auto mb-3 w-full max-w-3xl max-md:mb-[max(0.75rem,env(safe-area-inset-bottom))]"
      data-empty={isEmpty}
      data-running={isRunning}
    >
      <div className="overflow-hidden rounded-[24px] bg-[#f8f8f8] shadow-xs ring-1 ring-[#e5e5e5] ring-inset transition-shadow focus-within:ring-[#d0d0d0] dark:bg-[#212121] dark:ring-[#2a2a2a] dark:focus-within:ring-[#3a3a3a]">
        <ComposerPrimitive.AttachmentDropzone className="block">
          <ComposerAttachments className="px-3 pt-2.5" />
          <div className="flex items-center gap-1 px-2 py-1.5">
            <ComposerAddAttachment />
            <ComposerPrimitive.Input
              id="kb-qa-composer-input"
              name="message"
              placeholder={placeholder}
              minRows={1}
              onFocus={onComposerFocus}
              className="ml-1 max-h-100 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-[#0d0d0d] text-base leading-6 outline-none placeholder:text-[#9a9a9a] dark:text-white dark:placeholder:text-[#6b6b6b]"
            />

            {/* 问答模式：普通（分片/章节）或 Wiki（页面级检索 + 内联引用） */}
            <InlineModeSwitch value={qaMode} onChange={onQaModeChange} />

            <InlineScopeSelector
              knowledgeBases={knowledgeBases}
              docLibraries={docLibraries}
              value={focusSelection}
              onChange={onFocusChange}
              scopeLabel={scopeLabel}
              isEmpty={isEmpty}
            />

            <div className="relative size-8 shrink-0 rounded-full bg-[#0d0d0d] text-white dark:bg-[#e8e8e8] dark:text-[#0d0d0d]">
              <GsapFade
                visible={!isRunning}
                className="absolute inset-0"
              >
                <ComposerPrimitive.Send
                  className="flex h-full w-full items-center justify-center disabled:opacity-40"
                  disabled={isEmpty}
                >
                  <ArrowUp className="size-4" strokeWidth={2.25} />
                </ComposerPrimitive.Send>
              </GsapFade>

              <GsapFade
                visible={isRunning}
                className="absolute inset-0"
              >
                <ComposerPrimitive.Cancel className="flex h-full w-full items-center justify-center">
                  <Square className="size-3.5 fill-current" />
                </ComposerPrimitive.Cancel>
              </GsapFade>
            </div>
          </div>
        </ComposerPrimitive.AttachmentDropzone>
      </div>
      {contextWindow ? (
        <div className="mx-2 mt-1.5 flex min-h-6 items-center justify-between gap-3 text-[11px] leading-none text-[#9a9a9a] dark:text-[#6b6b6b]">
          <div className="min-w-0 flex-1">
            <BottomModelSelector
              modelInfo={modelInfo}
              selectedConfigId={selectedConfigId}
              availableModels={availableModels}
              onChange={onConfigChange}
            />
          </div>
          <div className="flex shrink-0 items-center">
            <ComposerContextBar contextWindow={contextWindow} />
          </div>
        </div>
      ) : null}
    </ComposerPrimitive.Root>
  )
}

export function ComposerContextBar({ contextWindow }: { contextWindow: number }) {
  const usage = useThreadTokenUsage()
  return (
    <ContextDisplay.Bar
      className="h-6 px-0 py-0"
      modelContextWindow={contextWindow}
      side="top"
      usage={usage}
    />
  )
}

const QA_MODE_OPTIONS = [
  { key: "normal" as const, label: "问答", icon: MessageCircleQuestion, title: "普通问答：检索知识库分片与章节回答" },
  { key: "wiki" as const, label: "Wiki", icon: BookOpen, title: "Wiki 问答：基于 Wiki 页面回答，答案内嵌可点击的页面引用" },
]

/** 问答模式切换（普通 / Wiki）：Wiki 模式下服务端走 WeKnora 式页面检索，回答带 [[..]] 引用。 */
export function InlineModeSwitch({
  value,
  onChange,
}: {
  value: "normal" | "wiki"
  onChange: (next: "normal" | "wiki") => void
}) {
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-0.5 rounded-full bg-[#f0f0f0] p-0.5 dark:bg-[#2a2a2a]"
      role="group"
      aria-label="问答模式"
    >
      {QA_MODE_OPTIONS.map((option) => {
        const active = option.key === value
        const Icon = option.icon
        return (
          <button
            key={option.key}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.key)}
            className={cn(
              "flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium outline-none transition-colors",
              active
                ? "bg-white text-[#0d0d0d] shadow-xs dark:bg-[#3a3a3a] dark:text-white"
                : "text-[#6b6b6b] hover:text-[#0d0d0d] dark:text-[#9a9a9a] dark:hover:text-white",
            )}
          >
            <Icon className={cn("size-3.5 shrink-0", active && option.key === "wiki" && "text-violet-600 dark:text-violet-300")} />
            <span className={cn(option.key === "wiki" && active && "text-violet-600 dark:text-violet-300")}>
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function InlineScopeSelector({
  knowledgeBases,
  docLibraries,
  value,
  onChange,
  scopeLabel,
  isEmpty,
}: {
  knowledgeBases: KnowledgeBaseQaSummary[]
  docLibraries: DocLibrary[]
  value: AssistantFocusSelection
  onChange: (next: AssistantFocusSelection) => void
  scopeLabel: string
  isEmpty: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const isAll = value.kind === "none"
  const ScopeIcon = value.kind === "doc_library" ? FileText : isAll ? Globe2 : Library

  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const innerRef = React.useRef<HTMLDivElement | null>(null)
  const mountedRef = React.useRef(false)

  React.useLayoutEffect(() => {
    const trigger = triggerRef.current
    const inner = innerRef.current
    if (!trigger || !inner) return

    const targets = isEmpty
      ? { pad: 10, gap: 6, innerMax: 160, innerOpacity: 1 }
      : { pad: 0, gap: 0, innerMax: 0, innerOpacity: 0 }

    if (!mountedRef.current) {
      mountedRef.current = true
      gsap.set(trigger, {
        width: isEmpty ? "auto" : "2rem",
        paddingLeft: targets.pad,
        paddingRight: targets.pad,
        gap: targets.gap,
      })
      gsap.set(inner, { maxWidth: targets.innerMax, autoAlpha: targets.innerOpacity })
      return
    }

    const tweens = [
      gsap.to(trigger, {
        width: isEmpty ? "auto" : "2rem",
        paddingLeft: targets.pad,
        paddingRight: targets.pad,
        gap: targets.gap,
        duration: 0.28,
        ease: "power3.out",
        overwrite: "auto",
      }),
      gsap.to(inner, {
        maxWidth: targets.innerMax,
        autoAlpha: targets.innerOpacity,
        duration: 0.28,
        ease: "power3.out",
        overwrite: "auto",
      }),
    ]
    return () => {
      tweens.forEach((t) => t.kill())
    }
  }, [isEmpty])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        className={cn(
          "flex h-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-[#3d3d3d] will-change-[width,padding,gap] transition-colors duration-150 hover:bg-[#ececec] hover:text-[#0d0d0d] data-[state=open]:bg-[#ececec] data-[state=open]:text-[#0d0d0d] dark:text-[#c8c8c8] dark:hover:bg-[#2a2a2a] dark:hover:text-white dark:data-[state=open]:bg-[#2a2a2a] dark:data-[state=open]:text-white",
        )}
        aria-label="选择提问范围"
      >
        <ScopeIcon className={cn("size-4 shrink-0", isAll && "text-violet-600 dark:text-violet-300")} />
        <div
          ref={innerRef}
          className="flex items-center gap-1 overflow-hidden will-change-[max-width,opacity]"
        >
          <span className="max-w-[10rem] truncate whitespace-nowrap text-sm font-medium">
            {scopeLabel}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-70" />
        </div>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-[min(320px,calc(100vw-2rem))] p-0">
        <Command>
          <CommandInput placeholder="搜索知识库或文档库..." />
          <CommandList>
            <CommandEmpty>没有找到范围</CommandEmpty>
            <CommandGroup heading="范围">
              <CommandItem
                value="all all-sources 全部资料"
                onSelect={() => {
                  onChange({ kind: "none" })
                  setOpen(false)
                }}
              >
                <Globe2 className="size-3.5 text-violet-600 dark:text-violet-300" />
                <span className="flex-1">全部资料</span>
                {isAll ? <Check className="size-3.5 text-primary" /> : null}
              </CommandItem>
            </CommandGroup>
            {knowledgeBases.length > 0 ? (
              <CommandGroup heading="知识库">
                {knowledgeBases.map((kb) => (
                  <CommandItem
                    key={`kb-${kb.id}`}
                    value={`kb ${kb.name} ${kb.id}`}
                    onSelect={() => {
                      onChange({ kind: "knowledge", knowledgeBaseId: kb.id })
                      setOpen(false)
                    }}
                  >
                    <Library className="size-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{kb.name}</span>
                    {value.kind === "knowledge" && value.knowledgeBaseId === kb.id ? <Check className="size-3.5 text-primary" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {docLibraries.length > 0 ? (
              <CommandGroup heading="文档库">
                {docLibraries.map((lib) => (
                  <CommandItem
                    key={`lib-${lib.id}`}
                    value={`lib ${lib.name} ${lib.id}`}
                    onSelect={() => {
                      onChange({ kind: "doc_library", libraryId: lib.id })
                      setOpen(false)
                    }}
                  >
                    <FileText className="size-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{lib.name}</span>
                    {value.kind === "doc_library" && value.libraryId === lib.id ? <Check className="size-3.5 text-primary" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function BottomModelSelector({
  modelInfo,
  selectedConfigId,
  availableModels,
  onChange,
}: {
  modelInfo: KnowledgeBaseQaModelInfo | null
  selectedConfigId: string | null
  availableModels: KnowledgeBaseQaModelOption[]
  onChange: (next: string) => void
}) {
  const hasOptions = availableModels.length > 0
  const label = modelInfo?.modelName ?? modelInfo?.modelId ?? ""
  const subLabel = modelInfo?.modelName && modelInfo?.modelId && modelInfo.modelId !== modelInfo.modelName
    ? modelInfo.modelId
    : null

  if (!label) return <span />

  const trigger = (
    <button
      type="button"
      disabled={!hasOptions}
      className={cn(
        "-mx-1 inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 py-0.5 outline-none transition-colors hover:bg-[#f0f0f0] data-[state=open]:bg-[#f0f0f0] disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-[#2a2a2a] dark:data-[state=open]:bg-[#2a2a2a]",
      )}
      aria-label="切换模型"
    >
      <span className="truncate text-foreground/70">{label}</span>
      {subLabel ? <span className="truncate font-mono text-[10px]">{subLabel}</span> : null}
      {hasOptions ? <ChevronDown className="size-3 shrink-0 opacity-70" /> : null}
    </button>
  )

  if (!hasOptions) return trigger

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="min-w-[min(220px,calc(100vw-2rem))] p-1">
        {availableModels.map((option) => {
          const active = option.configId === selectedConfigId
          const ctx = formatContextWindow(option.contextWindow)
          return (
            <DropdownMenuItem
              key={option.configId}
              onSelect={() => onChange(option.configId)}
              className="flex items-center gap-2 px-2 py-1.5"
            >
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="truncate text-sm">{option.modelName}</span>
                {option.modelId && option.modelId !== option.modelName ? (
                  <span className="truncate font-mono text-[10px] text-muted-foreground">
                    {option.modelId}
                  </span>
                ) : null}
              </span>
              {ctx ? (
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{ctx}</span>
              ) : null}
              {active ? <Check className="size-3.5 text-primary" /> : <span className="size-3.5" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
