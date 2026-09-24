import * as React from "react"
import { Link } from "react-router-dom"
import { BookOpen, Folder, Loader2, X } from "@/components/iconimate"
import { toast } from "sonner"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { resolveAxiosErrorMessage } from "@/components/knowledge/article-share-utils"
import { inboxApi, knowledgeBaseApi, knowledgeBaseNodeApi, type InboxArchiveRecommendation as Recommendation, type InboxSuggestedDestination, type InboxNote, type KnowledgeBaseResponse, type KnowledgeBaseTreeNode } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"
import { suggestInboxTitle } from "./inbox-utils"
import { InboxArchiveRecommendation } from "./InboxArchiveRecommendation"

function foldersFromTree(nodes: KnowledgeBaseTreeNode[], path = ""): { id: string; path: string }[] {
  return nodes.flatMap((node) => node.type === "FOLDER" ? [{ id: node.id, path: path + node.name }, ...foldersFromTree(node.children ?? [], path + node.name + " / ")] : [])
}

export function InboxArchiveDialog({ note, onClose, onArchived }: { note: InboxNote; onClose: () => void; onArchived: (note: InboxNote) => void }) {
  const [title, setTitle] = React.useState(() => suggestInboxTitle(note.contentMd, note.contentJson))
  const [bases, setBases] = React.useState<KnowledgeBaseResponse[]>([])
  const [baseId, setBaseId] = React.useState("")
  const [parentId, setParentId] = React.useState("root")
  const [folders, setFolders] = React.useState<{ id: string; path: string }[]>([])
  const [loading, setLoading] = React.useState(true)
  const [foldersLoading, setFoldersLoading] = React.useState(false)
  const [foldersError, setFoldersError] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [retry, setRetry] = React.useState(0)
  const [tags, setTags] = React.useState(() => [...note.tags])
  const [recommendation, setRecommendation] = React.useState<Recommendation | null>(null)
  const [applied, setApplied] = React.useState(false)
  const [recommendationApplied, setRecommendationApplied] = React.useState(false)
  const pendingFolder = React.useRef<{ baseId: string; parentId: string } | null>(null)
  const savingRef = React.useRef(false)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    // 列表按分页加载，避免知识库较多时只能归档到第一页。
    void (async () => {
      const result: KnowledgeBaseResponse[] = []
      let pageNum = 1
      while (active) {
        const { data } = await knowledgeBaseApi.list({ pageNum, pageSize: 100 })
        result.push(...data.rows)
        if (!data.rows.length || result.length >= data.total) break
        pageNum++
      }
      if (active) { setBases(result); setBaseId((value) => value || result[0]?.id || "") }
    })().catch((cause: unknown) => { if (active) setError(resolveAxiosErrorMessage(cause, "知识库加载失败")) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [retry])

  React.useEffect(() => {
    if (!baseId) return
    let active = true
    setFoldersLoading(true)
    setFoldersError(null)
    setFolders([])
    void (async () => {
      const all: KnowledgeBaseTreeNode[] = []
      let pageNum = 1
      while (active) {
        const { data } = await knowledgeBaseNodeApi.tree(baseId, { pageNum, pageSize: 100 })
        all.push(...data.roots)
        if (!data.roots.length || all.length >= (data.totalRootNodes ?? all.length)) break
        pageNum++
      }
      if (active) {
        const next = foldersFromTree(all)
        setFolders(next)
        const pending = pendingFolder.current
        if (pending?.baseId === baseId) {
          if (pending.parentId === "root" || next.some((folder) => folder.id === pending.parentId)) setParentId(pending.parentId)
          else { setParentId("root"); setApplied(false); setError("推荐文件夹已变更，请重新选择保存位置") }
          pendingFolder.current = null
        }
      }
    })().catch((cause: unknown) => { if (active) setFoldersError(resolveAxiosErrorMessage(cause, "文件夹加载失败")) }).finally(() => { if (active) setFoldersLoading(false) })
    return () => { active = false }
  }, [baseId, retry])

  function applyRecommendation(destination: InboxSuggestedDestination | null, suggestedTags: string[]) {
    if (savingRef.current) return
    if (destination) {
      if (!bases.some((base) => base.id === destination.knowledgeBaseId)) { setError("推荐知识库已变更，请重新加载"); return }
      const nextParent = destination.parentId ?? "root"
      if (baseId !== destination.knowledgeBaseId || foldersLoading || foldersError) {
        pendingFolder.current = { baseId: destination.knowledgeBaseId, parentId: nextParent }
        setFoldersLoading(true)
        setParentId("root")
        if (baseId === destination.knowledgeBaseId) setRetry((value) => value + 1)
        setBaseId(destination.knowledgeBaseId)
      } else if (nextParent === "root" || folders.some((folder) => folder.id === nextParent)) setParentId(nextParent)
      else { setError("推荐文件夹已变更，请重新加载"); return }
    }
    // 采纳只添加已有标签，保留用户原有选择；真正保存仍由确认归档完成。
    setTags((current) => [...new Set([...current, ...suggestedTags])].slice(0, 20))
    setError(null)
    setApplied(Boolean(recommendation && recommendation.tags.every((tag) => tags.includes(tag) || suggestedTags.includes(tag)) && (!recommendation.destination || (destination?.knowledgeBaseId === recommendation.destination.knowledgeBaseId && destination.parentId === recommendation.destination.parentId))))
    setRecommendationApplied(true)
  }

  async function archive() {
    if (savingRef.current || !baseId || !title.trim() || loading || foldersLoading || foldersError || pendingFolder.current) return
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const { data } = await inboxApi.archive({ id: note.id, version: note.version, knowledgeBaseId: baseId, parentId: parentId === "root" ? null : parentId, title: title.trim(), tags, recommendationToken: recommendation?.feedbackToken, recommendationApplied })
      toast.success("已归档到知识库")
      onArchived(data)
    } catch (cause) { setError(resolveAxiosErrorMessage(cause, "归档失败，随笔已保留")) }
    finally { savingRef.current = false; setSaving(false) }
  }

  return <ModalShell open onOpenChange={(open) => { if (!open) onClose() }} disableClose={saving}
    title="归档到知识库" description="将随笔整理为一篇正式文章，保留正文、图片和标签。原随笔仍保留归档记录。"
    footer={<><Button type="button" variant="outline" disabled={saving} onClick={onClose}>取消</Button><Button type="button" disabled={saving || loading || foldersLoading || Boolean(foldersError) || !baseId || !title.trim()} onClick={() => void archive()}>{saving ? <Loader2 className="size-4 animate-spin" /> : <BookOpen className="size-4" />}确认归档</Button></>}>
    <div className="space-y-5 py-2">
      {!loading && bases.length > 0 && <InboxArchiveRecommendation note={note} disabled={saving} applied={applied} onResult={(result) => { setRecommendation(result); setApplied(false); setRecommendationApplied(false) }} onApply={applyRecommendation} />}
      <div className="space-y-2"><Label htmlFor="inbox-archive-title">文章标题</Label><Input id="inbox-archive-title" value={title} maxLength={200} disabled={saving} onChange={(event) => setTitle(event.target.value)} /></div>
      {loading ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载知识库…</p> : bases.length > 0 ? <>
        <div className="space-y-2"><Label htmlFor="inbox-archive-base">知识库</Label><Select value={baseId} disabled={saving} onValueChange={(value) => { pendingFolder.current = null; setBaseId(value); setParentId("root"); setApplied(false) }}><SelectTrigger id="inbox-archive-base" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{bases.map((base) => <SelectItem value={base.id} key={base.id}>{base.name}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor="inbox-archive-folder">保存位置</Label><Select value={parentId} disabled={saving || foldersLoading || Boolean(foldersError)} onValueChange={(value) => { setParentId(value); setApplied(false) }}><SelectTrigger id="inbox-archive-folder" className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="root"><Folder className="size-4" />知识库根目录</SelectItem>{folders.map((folder) => <SelectItem value={folder.id} key={folder.id}>{folder.path}</SelectItem>)}</SelectContent></Select>{foldersLoading && <p role="status" className="text-xs text-muted-foreground">正在加载文件夹…</p>}</div>
      </> : !error && <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">还没有知识库。<Link to={dashboardRoutes.knowledge} className="ml-1 text-primary underline" onClick={onClose}>先去创建一个</Link>，你的随笔会保留，可稍后归档。</div>}
      <div className="space-y-2"><Label>文章标签</Label><div className="flex flex-wrap gap-1.5">{tags.map((tag) => <span key={tag} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted py-1 pl-2 pr-1 text-xs"><span className="break-words">#{tag}</span><button type="button" aria-label={`移除标签 ${tag}`} disabled={saving} className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" onClick={() => { setTags((current) => current.filter((value) => value !== tag)); setApplied(false) }}><X className="size-3" /></button></span>)}</div><p className="text-xs text-muted-foreground">{tags.length ? "标签随文章保存，原随笔的标签保持不变。" : "暂无标签，可从智能推荐中采纳已有标签。"}</p></div>
      {(error || foldersError) && <div role="alert" className="text-sm text-destructive">{error || foldersError}<Button type="button" variant="link" disabled={saving} onClick={() => setRetry((value) => value + 1)}>重新加载</Button></div>}
    </div>
  </ModalShell>
}
