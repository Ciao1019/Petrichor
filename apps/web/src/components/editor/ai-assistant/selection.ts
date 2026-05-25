// 从 Plate editor 抽取选中文本与上下文
import type { PlateEditor } from "platejs/react"
import { serializeMarkdown } from "@/components/plate/plate-markdown"
import type { AiAssistantContext } from "./types"

const MAX_CONTEXT_CHARS = 6000

export function captureSelectionContext(editor: PlateEditor): AiAssistantContext {
  const selection = editor.selection
  const fullMarkdown = serializeMarkdownSafe(editor)
  const selectedText = readSelectionString(editor)
  const hasSelection = Boolean(selection) && !editor.api.isCollapsed() && selectedText.length > 0

  if (!hasSelection) {
    // 续写场景：把整篇都当作 contextBefore；contextAfter 留空
    return {
      selectedText: "",
      contextBefore: clampHead(fullMarkdown, MAX_CONTEXT_CHARS),
      contextAfter: "",
      hasSelection: false,
    }
  }

  const { before, after } = splitMarkdownByText(fullMarkdown, selectedText)
  return {
    selectedText,
    contextBefore: clampTail(before, MAX_CONTEXT_CHARS),
    contextAfter: clampHead(after, MAX_CONTEXT_CHARS),
    hasSelection: true,
  }
}

function readSelectionString(editor: PlateEditor): string {
  try {
    if (!editor.selection) return ""
    return editor.api.string(editor.selection)
  } catch {
    return ""
  }
}

function serializeMarkdownSafe(editor: PlateEditor) {
  try {
    return serializeMarkdown(editor)
  } catch {
    return ""
  }
}

// 用选中文本在整篇 markdown 中做一次定位，失败时回退到「整篇为 before」
function splitMarkdownByText(full: string, selected: string) {
  if (!selected) {
    return { before: full, after: "" }
  }
  const index = full.indexOf(selected)
  if (index < 0) {
    return { before: full, after: "" }
  }
  return {
    before: full.slice(0, index),
    after: full.slice(index + selected.length),
  }
}

function clampHead(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}\n\n[已截断]`
}

function clampTail(value: string, max: number) {
  return value.length <= max ? value : `[已截断]\n\n${value.slice(value.length - max)}`
}
