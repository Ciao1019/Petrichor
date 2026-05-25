"use client"

import * as React from "react"
import {
  ArrowDownToLine,
  Languages,
  Loader2,
  PencilLine,
  RefreshCcw,
  Replace,
  Sparkles,
  Wand2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Markdown } from "@/components/ui/markdown"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useEditorRef } from "platejs/react"

import { replaceSelectionWithMarkdown, insertMarkdownBelow } from "./insert"
import { streamAiWrite } from "./stream-client"
import {
  ACTION_LABEL,
  TONE_PRESETS,
  TONE_PRESET_LABEL,
  TRANSLATE_LANGUAGES,
  TRANSLATE_LANGUAGE_LABEL,
  WRITE_ACTIONS,
  type AiAssistantContext,
  type TonePreset,
  type TranslateLanguage,
  type WriteAction,
} from "./types"

type Status = "menu" | "streaming" | "done" | "error"

interface AiAssistantDialogProps {
  isOpen: boolean
  context: AiAssistantContext | null
  initialAction: WriteAction | null
  onClose: () => void
}

const REQUIRES_SELECTION: WriteAction[] = ["rewrite", "expand", "shorten", "translate", "tone"]

export function AiAssistantDialog({ isOpen, context, initialAction, onClose }: AiAssistantDialogProps) {
  const editor = useEditorRef()

  const [status, setStatus] = React.useState<Status>("menu")
  const [action, setAction] = React.useState<WriteAction | null>(null)
  const [language, setLanguage] = React.useState<TranslateLanguage>("en")
  const [tone, setTone] = React.useState<TonePreset>("professional")
  const [output, setOutput] = React.useState("")
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  const resetState = React.useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStatus("menu")
    setAction(null)
    setOutput("")
    setErrorMessage(null)
  }, [])

  React.useEffect(() => {
    if (!isOpen) return
    setStatus("menu")
    setAction(initialAction)
    setOutput("")
    setErrorMessage(null)
    if (initialAction) {
      // 自动触发
      requestAnimationFrame(() => {
        if (context) runStream(initialAction, context)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialAction])

  React.useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const runStream = React.useCallback(async (
    nextAction: WriteAction,
    nextContext: AiAssistantContext,
    overrides?: { language?: TranslateLanguage; tone?: TonePreset },
  ) => {
    if (REQUIRES_SELECTION.includes(nextAction) && !nextContext.hasSelection) {
      setErrorMessage("请先选中要操作的文本")
      setStatus("error")
      return
    }
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setAction(nextAction)
    setOutput("")
    setErrorMessage(null)
    setStatus("streaming")

    await streamAiWrite(
      {
        action: nextAction,
        selectedText: nextContext.selectedText,
        contextBefore: nextContext.contextBefore,
        contextAfter: nextContext.contextAfter,
        hasSelection: nextContext.hasSelection,
        language: nextAction === "translate" ? (overrides?.language ?? language) : null,
        tone: nextAction === "tone" ? (overrides?.tone ?? tone) : null,
      },
      {
        signal: controller.signal,
        onChunk: (chunk) => {
          setOutput((prev) => prev + chunk)
        },
        onError: (message) => {
          setErrorMessage(message)
          setStatus("error")
        },
        onDone: () => {
          setStatus("done")
        },
      },
    )
  }, [language, tone])

  const handleSelectAction = (next: WriteAction) => {
    if (!context) return
    void runStream(next, context)
  }

  const handleRetry = () => {
    if (!action || !context) return
    void runStream(action, context)
  }

  const handleClose = () => {
    abortRef.current?.abort()
    onClose()
    resetState()
  }

  const handleReplace = () => {
    if (!output.trim()) return
    replaceSelectionWithMarkdown(editor, output)
    toast.success("已替换选中文本")
    handleClose()
  }

  const handleInsertBelow = () => {
    if (!output.trim()) return
    insertMarkdownBelow(editor, output)
    toast.success("已插入到下方")
    handleClose()
  }

  const handleLanguageChange = (value: string) => {
    const next = value as TranslateLanguage
    setLanguage(next)
    if (context) void runStream("translate", context, { language: next })
  }

  const handleToneChange = (value: string) => {
    const next = value as TonePreset
    setTone(next)
    if (context) void runStream("tone", context, { tone: next })
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) handleClose()
      }}
    >
      <DialogContent className="max-w-2xl gap-0 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" />
            AI 写作助手
            {action ? (
              <Badge variant="secondary" className="ml-1 text-xs">{ACTION_LABEL[action]}</Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {context?.hasSelection
              ? `已选择 ${context.selectedText.length} 个字符。`
              : "未选择文本，可以使用续写。"}
          </DialogDescription>
        </DialogHeader>

        {status === "menu" ? (
          <ActionMenu
            context={context}
            onSelect={handleSelectAction}
          />
        ) : (
          <ResultPanel
            status={status}
            action={action}
            output={output}
            errorMessage={errorMessage}
            language={language}
            tone={tone}
            onLanguageChange={handleLanguageChange}
            onToneChange={handleToneChange}
            onRetry={handleRetry}
          />
        )}

        <Separator />
        <DialogFooter className="flex-row items-center justify-between gap-2 px-5 py-3">
          <div className="text-xs text-muted-foreground">
            {status === "streaming" ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="size-3 animate-spin" /> 生成中…
              </span>
            ) : status === "done" ? (
              <span>生成完成，可以替换或插入</span>
            ) : status === "error" ? (
              <span className="text-destructive">出错了</span>
            ) : (
              <span>请选择操作</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {status !== "menu" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStatus("menu")}
                disabled={status === "streaming"}
              >
                返回菜单
              </Button>
            ) : null}
            {status === "done" ? (
              <>
                <Button variant="outline" size="sm" onClick={handleInsertBelow}>
                  <ArrowDownToLine className="size-4" /> 在下方插入
                </Button>
                <Button size="sm" onClick={handleReplace} disabled={!context?.hasSelection}>
                  <Replace className="size-4" /> 替换选中
                </Button>
              </>
            ) : null}
            <Button variant="ghost" size="sm" onClick={handleClose}>
              <X className="size-4" /> 关闭
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ActionMenu({
  context,
  onSelect,
}: {
  context: AiAssistantContext | null
  onSelect: (action: WriteAction) => void
}) {
  const hasSelection = Boolean(context?.hasSelection)
  return (
    <div className="grid grid-cols-2 gap-2 p-5">
      {WRITE_ACTIONS.map((action) => {
        const requiresSelection = REQUIRES_SELECTION.includes(action)
        const disabled = requiresSelection && !hasSelection
        return (
          <button
            key={action}
            type="button"
            onClick={() => onSelect(action)}
            disabled={disabled}
            className={cn(
              "flex items-center gap-3 rounded-md border bg-card px-3 py-3 text-left text-sm transition",
              "hover:bg-accent hover:text-accent-foreground",
              disabled && "cursor-not-allowed opacity-50 hover:bg-card hover:text-foreground",
            )}
          >
            <ActionIcon action={action} />
            <div className="flex flex-col">
              <span className="font-medium">{ACTION_LABEL[action]}</span>
              <span className="text-xs text-muted-foreground">{actionHint(action)}</span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

function ActionIcon({ action }: { action: WriteAction }) {
  switch (action) {
    case "continue": return <PencilLine className="size-4 text-primary" />
    case "rewrite": return <Wand2 className="size-4 text-primary" />
    case "expand": return <Sparkles className="size-4 text-primary" />
    case "shorten": return <Sparkles className="size-4 text-primary rotate-180" />
    case "translate": return <Languages className="size-4 text-primary" />
    case "tone": return <Wand2 className="size-4 text-primary" />
  }
}

function actionHint(action: WriteAction) {
  switch (action) {
    case "continue": return "基于上文自然延续"
    case "rewrite": return "保留原意，换种表达"
    case "expand": return "补充细节与例子"
    case "shorten": return "压缩冗余表达"
    case "translate": return "翻译为指定语言"
    case "tone": return "切换为指定语气"
  }
}

function ResultPanel({
  status,
  action,
  output,
  errorMessage,
  language,
  tone,
  onLanguageChange,
  onToneChange,
  onRetry,
}: {
  status: Status
  action: WriteAction | null
  output: string
  errorMessage: string | null
  language: TranslateLanguage
  tone: TonePreset
  onLanguageChange: (value: string) => void
  onToneChange: (value: string) => void
  onRetry: () => void
}) {
  const showLanguageSwitcher = action === "translate"
  const showToneSwitcher = action === "tone"

  return (
    <div className="flex flex-col gap-3 px-5 pb-2 pt-3">
      {(showLanguageSwitcher || showToneSwitcher) ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {showLanguageSwitcher ? (
            <>
              <span>目标语言</span>
              <Select value={language} onValueChange={onLanguageChange}>
                <SelectTrigger className="h-7 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSLATE_LANGUAGES.map((lang) => (
                    <SelectItem key={lang} value={lang}>{TRANSLATE_LANGUAGE_LABEL[lang]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : null}
          {showToneSwitcher ? (
            <>
              <span>目标语气</span>
              <Select value={tone} onValueChange={onToneChange}>
                <SelectTrigger className="h-7 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONE_PRESETS.map((item) => (
                    <SelectItem key={item} value={item}>{TONE_PRESET_LABEL[item]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          ) : null}
        </div>
      ) : null}

      <ScrollArea className="max-h-[50vh] min-h-[16rem] rounded-md border bg-card">
        <div className="p-4 text-sm leading-relaxed">
          {status === "error" ? (
            <div className="space-y-3">
              <p className="text-destructive">{errorMessage ?? "生成失败"}</p>
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RefreshCcw className="size-4" /> 重试
              </Button>
            </div>
          ) : output ? (
            <Markdown>{output}</Markdown>
          ) : (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>正在生成…</span>
            </div>
          )}
          {status === "streaming" && output ? (
            <span className="ml-1 inline-block h-3 w-2 animate-pulse bg-primary align-middle" />
          ) : null}
        </div>
      </ScrollArea>

      {status === "done" && action ? (
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onRetry}>
            <RefreshCcw className="size-4" /> 重新生成
          </Button>
        </div>
      ) : null}
    </div>
  )
}
