// 把 AI 输出的 markdown 插入回 Plate editor
import type { PlateEditor } from "platejs/react"
import { deserializeMarkdown } from "@/components/plate/plate-markdown"

export function replaceSelectionWithMarkdown(editor: PlateEditor, markdown: string) {
  if (!markdown.trim()) return
  const nodes = deserializeMarkdown(editor, markdown.trim())
  if (!nodes.length) return
  editor.tf.focus()
  if (editor.selection && !editor.api.isCollapsed()) {
    editor.tf.delete()
  }
  editor.tf.insertNodes(nodes)
}

export function insertMarkdownBelow(editor: PlateEditor, markdown: string) {
  if (!markdown.trim()) return
  const nodes = deserializeMarkdown(editor, markdown.trim())
  if (!nodes.length) return
  editor.tf.focus()
  if (editor.selection && !editor.api.isCollapsed()) {
    // 折叠到选区末尾，再插入新块
    editor.tf.collapse({ edge: "end" })
  }
  // 跳到当前块末尾，避免插入到行内
  editor.tf.insertNodes(nodes, { select: true })
}
