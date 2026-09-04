"use client"

/**
 * assistant-tool-ui-mounts.tsx 助手工具卡片的统一挂载点。
 *
 * assistant-ui 的工具 UI 靠渲染对应组件来注册，散在页面里会让每加一个工具
 * 就要改一次聊天页。这里集中挂载，页面只渲染 <AssistantToolUIs />。
 */

import {
  SearchDocumentsToolUI,
  SearchKnowledgeToolUI,
} from "@/features/pages/assistant/search-tool-ui"
import {
  CitationToolUI,
  ConfirmationToolUI,
  ContextCompressDataUI,
  DataTableToolUI,
  IntentRouteDataUI,
  ListDocLibrariesToolUI,
  ListKbToolUI,
  ListSystemOverviewToolUI,
  PlanToolUI,
  PreviewArticleUpdateToolUI,
  ProgressToolUI,
  ReadDocumentToolUI,
  ReadKnowledgeToolUI,
  SaveArtifactToolUI,
  SpawnResearchFanoutToolUI,
  SpawnResearchSubagentToolUI,
  SpawnWriteSubagentToolUI,
  StepBudgetDataUI,
} from "./assistant-tool-renders"
import {
  ReadDocumentOutlineToolUI,
  SearchWikiPagesToolUI,
  WikiOverviewToolUI,
} from "./assistant-wiki-tool-renders"
import { AgentEventDataUI } from "./agent-run-ui"

export function AssistantToolUIs() {
  return (
    <>
      <PlanToolUI />
      <ProgressToolUI />
      <ConfirmationToolUI />
      <SpawnResearchSubagentToolUI />
      <SpawnResearchFanoutToolUI />
      <SpawnWriteSubagentToolUI />
      <ContextCompressDataUI />
      <IntentRouteDataUI />
      <AgentEventDataUI />
      <StepBudgetDataUI />
      <CitationToolUI />
      <DataTableToolUI />
      <ListSystemOverviewToolUI />
      <ListKbToolUI />
      <ListDocLibrariesToolUI />
      <SearchKnowledgeToolUI />
      <SearchDocumentsToolUI />
      <WikiOverviewToolUI />
      <SearchWikiPagesToolUI />
      <ReadKnowledgeToolUI />
      <ReadDocumentOutlineToolUI />
      <ReadDocumentToolUI />
      <SaveArtifactToolUI />
      <PreviewArticleUpdateToolUI />
    </>
  )
}
