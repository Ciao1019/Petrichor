import { BookOpen, CalendarIcon, ChevronLeft, FileText, Folder, FolderOpen, FolderPlus, Network, Plus, X } from "@/components/iconimate"
import { DndContext, DragOverlay } from "@dnd-kit/core"
import { SortableContext } from "@dnd-kit/sortable"
import { AnimatePresence, motion } from "motion/react"
import * as React from "react"
import type { DateRange } from "react-day-picker"
import type { NavigateFunction } from "react-router-dom"

import { ArrowUpTrayIcon, BookOpenIcon, DocumentPlusIcon, FolderPlusIcon } from "@/components/animated-icons"
import { AppPagination } from "@/components/app-pagination"
import { AstryxProvider } from "@/components/astryx/astryx-provider"
import { OrbitingCircles } from "@/components/godui/orbiting-circles"
import { DocumentImportDialog } from "@/components/knowledge/DocumentImportDialog"
import { AnimatedTabs } from "@/components/microinteractions/animated-tabs"
import { DateRangeCalendar } from "@/components/petrichor-ui/date-range-calendar"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeNestedList, type ListItem } from "@/components/uitripled/native-nested-list-shadcnui"
import { KnowledgeExplorerPanel } from "./KnowledgeExplorerDialog"
import { KnowledgeWikiGraphPanel } from "./KnowledgeWikiGraphPanel"
import type { KnowledgeBaseResponse, KnowledgeBaseTreeNode } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { KnowledgeBaseTreeCreateArticleDialog, type CreateArticleTarget } from "./knowledge-base-tree-create-article-dialog"
import {
  formatDateYmd,
  KnowledgeBaseDragOverlay,
  KnowledgeBaseHeaderAction,
  KnowledgeBaseViewLabel,
  normalizeDateRange,
  noSortingTransform,
  TREE_NODE_INDENT_PX,
  toKnowledgeBaseView,
  type DeleteTarget,
  type KnowledgeBaseView,
} from "./knowledge-base-tree-support"

interface KnowledgeBaseTreePageViewProps {
  knowledgeBaseId?: string
  navigate: NavigateFunction
  knowledgeBase: KnowledgeBaseResponse | null
  activeView: KnowledgeBaseView
  setActiveView: React.Dispatch<React.SetStateAction<KnowledgeBaseView>>
  wikiFocusPageKey: string | null
  setWikiFocusPageKey: React.Dispatch<React.SetStateAction<string | null>>
  openWikiPageFromGraph: (pageKey: string) => void
  prefersReducedMotion: boolean | null
  loading: boolean
  saving: boolean
  roots: KnowledgeBaseTreeNode[]
  keyword: string
  setKeyword: React.Dispatch<React.SetStateAction<string>>
  debouncedKeyword: string
  pageIndex: number
  setPageIndex: React.Dispatch<React.SetStateAction<number>>
  pageSize: number
  totalPages: number
  totalRootNodes: number
  articleCreatedDateRange: DateRange | undefined
  setArticleCreatedDateRange: React.Dispatch<React.SetStateAction<DateRange | undefined>>
  articleCreatedDateDraftRange: DateRange | undefined
  setArticleCreatedDateDraftRange: React.Dispatch<React.SetStateAction<DateRange | undefined>>
  articleCreatedDateOpen: boolean
  setArticleCreatedDateOpen: React.Dispatch<React.SetStateAction<boolean>>
  articleCreatedDateLabel: string
  hasArticleCreatedDateFilter: boolean
  openCreateFolder: (parent: CreateArticleTarget | null) => void
  openCreateArticle: (parent: CreateArticleTarget | null) => void
  setImportDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  importDialogOpen: boolean
  sensors: React.ComponentProps<typeof DndContext>["sensors"]
  collisionDetection: NonNullable<React.ComponentProps<typeof DndContext>["collisionDetection"]>
  handleDragStart: NonNullable<React.ComponentProps<typeof DndContext>["onDragStart"]>
  handleDragMove: NonNullable<React.ComponentProps<typeof DndContext>["onDragMove"]>
  handleDragEnd: NonNullable<React.ComponentProps<typeof DndContext>["onDragEnd"]>
  resetDrag: () => void
  visibleNodeDndIds: string[]
  treeItems: ListItem[]
  expandedIds: Set<string>
  handleTreeExpandedChange: (id: string, expanded: boolean) => void
  activeDragNode: KnowledgeBaseTreeNode | null
  handlePageChange: (pageIndex: number) => void
  createFolderOpen: boolean
  setCreateFolderOpen: React.Dispatch<React.SetStateAction<boolean>>
  createFolderParentId: string | null
  createFolderParentName: string | null
  createFolderName: string
  setCreateFolderName: React.Dispatch<React.SetStateAction<string>>
  submitCreateFolder: () => Promise<void>
  createArticleOpen: boolean
  createArticleTarget: CreateArticleTarget | null
  setCreateArticleOpen: React.Dispatch<React.SetStateAction<boolean>>
  setSaving: React.Dispatch<React.SetStateAction<boolean>>
  refreshTreeAfterCreateArticle: (parentId: string | null) => Promise<void>
  deleteOpen: boolean
  setDeleteOpen: React.Dispatch<React.SetStateAction<boolean>>
  deleteTarget: DeleteTarget | null
  confirmDelete: () => Promise<void>
}

export function KnowledgeBaseTreePageView(props: KnowledgeBaseTreePageViewProps) {
  const {
    knowledgeBaseId, navigate, knowledgeBase, activeView, setActiveView, wikiFocusPageKey,
    setWikiFocusPageKey, openWikiPageFromGraph, prefersReducedMotion, loading, saving, roots,
    keyword, setKeyword, debouncedKeyword, pageIndex, setPageIndex, pageSize, totalPages,
    totalRootNodes, articleCreatedDateRange, setArticleCreatedDateRange, articleCreatedDateDraftRange,
    setArticleCreatedDateDraftRange, articleCreatedDateOpen, setArticleCreatedDateOpen,
    articleCreatedDateLabel, hasArticleCreatedDateFilter, openCreateFolder, openCreateArticle,
    setImportDialogOpen, importDialogOpen, sensors, collisionDetection, handleDragStart,
    handleDragMove, handleDragEnd, resetDrag, visibleNodeDndIds, treeItems, expandedIds,
    handleTreeExpandedChange, activeDragNode, handlePageChange, createFolderOpen,
    setCreateFolderOpen, createFolderParentId, createFolderParentName, createFolderName,
    setCreateFolderName, submitCreateFolder, createArticleOpen, createArticleTarget,
    setCreateArticleOpen, setSaving, refreshTreeAfterCreateArticle, deleteOpen, setDeleteOpen,
    deleteTarget, confirmDelete,
  } = props
  return (
    <AstryxProvider>
    <div className="w-full p-4 lg:p-6">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 gap-1 px-2 text-muted-foreground hover:text-foreground"
            onClick={() => navigate(dashboardRoutes.knowledge)}
          >
            <ChevronLeft className="size-4" />
            知识库
          </Button>
          <div className="min-w-0">
            <h1 className="sr-only">{knowledgeBase?.name || "我的文档"}</h1>
            <AnimatedTabs
              value={activeView}
              size="lg"
              options={[
                {
                  ariaLabel: knowledgeBase?.name || "我的文档",
                  label: (
                    <KnowledgeBaseViewLabel
                      icon={<FileText className="size-[18px] shrink-0" />}
                      label={knowledgeBase?.name || "我的文档"}
                    />
                  ),
                  value: "documents",
                },
                {
                  ariaLabel: "知识空间",
                  label: (
                    <KnowledgeBaseViewLabel
                      icon={<BookOpenIcon className="shrink-0" size={18} />}
                      label="知识空间"
                    />
                  ),
                  value: "knowledge",
                },
                {
                  ariaLabel: "Wiki 图谱",
                  label: (
                    <KnowledgeBaseViewLabel
                      icon={<Network className="size-[18px] shrink-0" />}
                      label="Wiki 图谱"
                    />
                  ),
                  value: "graph",
                },
              ]}
              ariaLabel="知识库视图"
              // 用位移而不是负 margin 做左对齐：负 margin 会把父级的 max-content 也减掉 12px，
              // 标签栏自身的 max-w-full 就按这个夹窄的宽度收，最后一个触发区和指示条会被裁掉一截。
              className="-translate-x-3"
              onValueChange={(value) => {
                // 手动切标签就丢掉图谱交接的落点，避免下次回到知识空间又被拽回旧页面
                setWikiFocusPageKey(null)
                setActiveView(toKnowledgeBaseView(value))
              }}
            />
            {knowledgeBase?.description ? (
              <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                {knowledgeBase.description}
              </p>
            ) : null}
          </div>
        </div>
        <AnimatePresence initial={false}>
          {activeView === "documents" ? (
            <motion.div
              key="documents-actions"
              className="flex flex-wrap items-center gap-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.18 }}
            >
              <KnowledgeBaseHeaderAction
                icon={FolderPlusIcon}
                label="新建文件夹"
                disabled={!knowledgeBaseId || loading || saving}
                onClick={() => openCreateFolder(null)}
              />
              <KnowledgeBaseHeaderAction
                icon={ArrowUpTrayIcon}
                label="导入文档"
                disabled={!knowledgeBaseId}
                onClick={() => setImportDialogOpen(true)}
              />
              <KnowledgeBaseHeaderAction
                icon={DocumentPlusIcon}
                label="新建文章"
                disabled={!knowledgeBaseId || loading || saving}
                onClick={() => openCreateArticle(null)}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* 面板跟着切换滑动：旧视图先退场，新视图再从另一侧进来，方向和标签顺序一致。 */}
      <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={activeView}
        initial={{ opacity: 0, x: prefersReducedMotion ? 0 : -12 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: prefersReducedMotion ? 0 : 12 }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.22, ease: [0.32, 0.72, 0, 1] }}
      >
      {activeView === "documents" ? (
        <>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Input
            value={keyword}
            placeholder="搜索文件夹/文章名称"
            className="sm:w-[360px] lg:w-[420px]"
            onChange={(e) => {
              setKeyword(e.target.value)
              setPageIndex(0)
            }}
          />

          <div className="flex min-w-0 items-center gap-2">
            <DropdownMenu
              open={articleCreatedDateOpen}
              onOpenChange={(open) => {
                setArticleCreatedDateOpen(open)
                if (open) {
                  setArticleCreatedDateDraftRange(normalizeDateRange(articleCreatedDateRange))
                  return
                }
                setArticleCreatedDateDraftRange(undefined)
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="min-w-0 w-full justify-start sm:w-[320px]"
                >
                  <CalendarIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{articleCreatedDateLabel}</span>
                </Button>
              </DropdownMenuTrigger>

              <DropdownMenuContent
                align="end"
                side="bottom"
                sideOffset={8}
                className="p-0"
              >
                <div className="w-fit bg-background p-3">
                  <DateRangeCalendar
                    value={articleCreatedDateDraftRange ?? articleCreatedDateRange}
                    showRangeLabel={false}
                    onChange={(next) => {
                      setArticleCreatedDateDraftRange(next)
                      const normalized = normalizeDateRange(next)
                      if (normalized?.from && normalized?.to) {
                        setArticleCreatedDateRange(normalized)
                        setPageIndex(0)
                        setArticleCreatedDateOpen(false)
                        setArticleCreatedDateDraftRange(undefined)
                      }
                    }}
                  />
                  <div className="mt-2 text-muted-foreground text-xs">
                    {(() => {
                      const normalized = normalizeDateRange(articleCreatedDateDraftRange)
                      if (!normalized?.from) {
                        return "请选择开始日期"
                      }
                      if (!normalized.to) {
                        return `开始：${formatDateYmd(normalized.from)}，请继续选择结束日期`
                      }
                      return `将应用：${formatDateYmd(normalized.from)} ~ ${formatDateYmd(normalized.to)}`
                    })()}
                    <span className="ml-2">（仅按文章创建时间筛选）</span>
                  </div>
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            {hasArticleCreatedDateFilter ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => {
                  setArticleCreatedDateRange(undefined)
                  setArticleCreatedDateDraftRange(undefined)
                  setArticleCreatedDateOpen(false)
                  setPageIndex(0)
                }}
              >
                <X className="h-4 w-4" />
                清除日期
              </Button>
            ) : null}
          </div>
        </div>

        {loading ? (
          <div
            className="flex min-h-56 items-center justify-center py-10"
            role="status"
            aria-live="polite"
            aria-label="正在加载知识库"
          >
            <OrbitingCircles
              radius={52}
              duration={12}
              iconSize={36}
              className="text-muted-foreground"
            >
              <span className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background shadow-xs">
                <Folder className="size-4" />
              </span>
              <span className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background shadow-xs">
                <FileText className="size-4" />
              </span>
              <span className="flex size-9 items-center justify-center rounded-full border border-border/60 bg-background shadow-xs">
                <BookOpen className="size-4" />
              </span>
            </OrbitingCircles>
          </div>
        ) : roots.length === 0 ? (
          <Empty className="border border-dashed py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen />
              </EmptyMedia>
              <EmptyTitle>
                {debouncedKeyword || hasArticleCreatedDateFilter
                  ? "暂无匹配结果"
                  : "暂无文件 / 文件夹"}
              </EmptyTitle>
              <EmptyDescription>
                {debouncedKeyword || hasArticleCreatedDateFilter
                  ? "调整搜索词或日期筛选后再试。"
                  : "从一篇文章或一个文件夹开始整理这个知识库。"}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              {debouncedKeyword || hasArticleCreatedDateFilter ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setKeyword("")
                    setArticleCreatedDateRange(undefined)
                    setArticleCreatedDateDraftRange(undefined)
                    setPageIndex(0)
                  }}
                >
                  清除筛选
                </Button>
              ) : (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!knowledgeBaseId || loading || saving}
                    onClick={() => openCreateFolder(null)}
                  >
                    <FolderPlus className="size-4" />
                    新建文件夹
                  </Button>
                  <Button
                    type="button"
                    disabled={!knowledgeBaseId || loading || saving}
                    onClick={() => openCreateArticle(null)}
                  >
                    <Plus className="size-4" />
                    新建文章
                  </Button>
                </div>
              )}
            </EmptyContent>
          </Empty>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragCancel={resetDrag}
            onDragEnd={(event) => {
              void handleDragEnd(event)
            }}
          >
            <SortableContext items={visibleNodeDndIds} strategy={noSortingTransform}>
              <NativeNestedList
                className="p-2"
                items={treeItems}
                indentSize={TREE_NODE_INDENT_PX}
                expandedIds={expandedIds}
                onExpandedChange={handleTreeExpandedChange}
              />
            </SortableContext>
            <DragOverlay>
              <KnowledgeBaseDragOverlay node={activeDragNode} />
            </DragOverlay>
          </DndContext>
        )}
        </div>

        <div className="py-3 mt-2">
          <AppPagination
            page={pageIndex}
            totalPages={totalPages}
            total={totalRootNodes}
            pageSize={pageSize}
            onChange={handlePageChange}
          />
        </div>
        </>
      ) : !knowledgeBaseId ? null : activeView === "graph" ? (
        <KnowledgeWikiGraphPanel
          knowledgeBaseId={knowledgeBaseId}
          onOpenPage={openWikiPageFromGraph}
        />
      ) : (
        <KnowledgeExplorerPanel
          knowledgeBaseId={knowledgeBaseId}
          focusPageKey={wikiFocusPageKey}
        />
      )}
      </motion.div>
      </AnimatePresence>

      <ModalShell
        open={createFolderOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setCreateFolderOpen(open)
        }}
        disableClose={saving}
        title="新建文件夹"
        description={
          createFolderParentId
            ? `将在 ${createFolderParentName || "当前文件夹"} 下创建`
            : "将在根目录创建"
        }
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setCreateFolderOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={saving} onClick={submitCreateFolder}>
              {saving ? "创建中..." : "创建"}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="folder-name">名称</Label>
          <Input
            id="folder-name"
            value={createFolderName}
            placeholder="例如：产品文档"
            disabled={saving}
            onChange={(e) => setCreateFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              e.preventDefault()
              void submitCreateFolder()
            }}
          />
        </div>
      </ModalShell>

      <KnowledgeBaseTreeCreateArticleDialog
        knowledgeBaseId={knowledgeBaseId}
        open={createArticleOpen}
        target={createArticleTarget}
        saving={saving}
        onOpenChange={setCreateArticleOpen}
        onSavingChange={setSaving}
        onCreated={refreshTreeAfterCreateArticle}
      />

      <ModalShell
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && saving) return
          setDeleteOpen(open)
        }}
        disableClose={saving}
        title="确认删除？"
        description={
          deleteTarget?.type === "folder"
            ? `将删除文件夹“${deleteTarget.name}”，并级联删除其下所有内容。`
            : deleteTarget?.type === "article"
              ? `将删除文章“${deleteTarget.name}”。`
              : "将删除所选内容。"
        }
        footer={
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => setDeleteOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={saving || !deleteTarget}
              onClick={confirmDelete}
            >
              {saving ? "删除中..." : "确认删除"}
            </Button>
          </>
        }
      />

      {knowledgeBaseId ? (
        <DocumentImportDialog
          open={importDialogOpen}
          onOpenChange={setImportDialogOpen}
          knowledgeBaseId={knowledgeBaseId}
          onViewJobs={() => navigate(dashboardRoutes.imports)}
        />
      ) : null}
    </div>
    </AstryxProvider>
  )
}
