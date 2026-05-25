"use client"

import * as React from "react"
import { Sparkles } from "lucide-react"
import { useEditorReadOnly, useEditorRef } from "platejs/react"

import { ToolbarButton } from "@/components/ui/toolbar"
import { useOptionalAiAssistant } from "./ai-assistant-context"
import { captureSelectionContext } from "./selection"

export function AiAssistantToolbarButton() {
  const editor = useEditorRef()
  const readOnly = useEditorReadOnly()
  const assistant = useOptionalAiAssistant()

  if (readOnly || !assistant) {
    return null
  }

  const handleClick = (event: React.MouseEvent) => {
    event.preventDefault()
    const ctx = captureSelectionContext(editor)
    assistant.open({ context: ctx })
  }

  return (
    <ToolbarButton
      tooltip="AI 写作助手"
      onMouseDown={(event) => event.preventDefault()}
      onClick={handleClick}
    >
      <Sparkles />
    </ToolbarButton>
  )
}
