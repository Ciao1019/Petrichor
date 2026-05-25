"use client"

import * as React from "react"
import type { AiAssistantContext as SelectionContext, WriteAction } from "./types"

export interface AiAssistantOpenOptions {
  context: SelectionContext
  initialAction?: WriteAction
}

// ---------------------------------------------------------------------------
// 模块级 store：避开 React Context 在浮动工具栏 / portal 路径上的传播问题
// ---------------------------------------------------------------------------

interface AssistantStoreState {
  isOpen: boolean
  context: SelectionContext | null
  initialAction: WriteAction | null
}

const CLOSED_STATE: AssistantStoreState = {
  isOpen: false,
  context: null,
  initialAction: null,
}

let currentState: AssistantStoreState = CLOSED_STATE
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

export function openAiAssistant(options: AiAssistantOpenOptions) {
  currentState = {
    isOpen: true,
    context: options.context,
    initialAction: options.initialAction ?? null,
  }
  emit()
}

export function closeAiAssistant() {
  if (!currentState.isOpen) return
  currentState = CLOSED_STATE
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return currentState
}

function getServerSnapshot() {
  return CLOSED_STATE
}

function useAssistantState() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

export interface AiAssistantControls {
  open: (options: AiAssistantOpenOptions) => void
}

const controls: AiAssistantControls = { open: openAiAssistant }

// 永远返回可用 controls —— 按钮可放在编辑器树的任意位置（包括浮动工具栏 / portal 内）
export function useAiAssistant(): AiAssistantControls {
  return controls
}

export function useOptionalAiAssistant(): AiAssistantControls {
  return controls
}

interface ProviderProps {
  children: React.ReactNode
  renderDialog: (props: {
    isOpen: boolean
    context: SelectionContext | null
    initialAction: WriteAction | null
    onClose: () => void
  }) => React.ReactNode
}

export function AiAssistantProvider({ children, renderDialog }: ProviderProps) {
  const state = useAssistantState()

  React.useEffect(() => {
    return () => {
      // 编辑器卸载时清理悬挂的状态，避免下次进入时残留
      closeAiAssistant()
    }
  }, [])

  return (
    <>
      {children}
      {renderDialog({
        isOpen: state.isOpen,
        context: state.context,
        initialAction: state.initialAction,
        onClose: closeAiAssistant,
      })}
    </>
  )
}
