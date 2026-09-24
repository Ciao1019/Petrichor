"use client"

/**
 * assistant-tool-ui-mounts.tsx 助手工具卡片的统一挂载点。
 *
 * assistant-ui 的工具 UI 靠渲染对应组件来注册，散在页面里会让每加一个工具
 * 就要改一次聊天页。这里集中挂载，页面只渲染 <AssistantToolUIs />。
 *
 * 检索、读取、列表、Wiki 与子代理等过程类工具不在回答正文里逐条展示：
 * 执行过程统一由回答上方的运行面板（「已完成 · N 个步骤」）汇总，
 * 未注册卡片的工具调用会被聊天正文忽略。这里只注册回答内容与需要用户操作的卡片。
 */

import {
  CitationToolUI,
  ConfirmationToolUI,
  ContextCompressDataUI,
  DataTableToolUI,
  IntentRouteDataUI,
  PlanToolUI,
  PreviewArticleUpdateToolUI,
  ProgressToolUI,
  StepBudgetDataUI,
} from "./assistant-tool-renders"
import { AgentEventDataUI } from "./agent-run-ui"

export function AssistantToolUIs() {
  return (
    <>
      <PlanToolUI />
      <ProgressToolUI />
      <ConfirmationToolUI />
      <ContextCompressDataUI />
      <IntentRouteDataUI />
      <AgentEventDataUI />
      <StepBudgetDataUI />
      <CitationToolUI />
      <DataTableToolUI />
      <PreviewArticleUpdateToolUI />
    </>
  )
}
