import { captureDemoSources, validCaptureDemoSources } from "./demo-capture"
import type { InboxNote, InboxListResponse, InboxArchiveRecommendation } from "@/lib/api-inbox"
import type { DemoHandler, DemoHandlerResult } from "./demo-adapter"
import { demoStore, kbById, nextArticleId, nextNodeId, nodesOf, touchKb } from "./demo-store"

const now = () => new Date().toISOString()
const notes: InboxNote[] = [
  { id: "demo-note-1", contentMd: "好的工具，应该先接住想法，再帮助整理。\n\n今天的灵感：让首页成为一个随时可以落笔的地方。无需标题，无需先选文件夹，先把脑海中的东西留下来。", tags: ["产品灵感", "随手记"], pinned: true, version: 1, createdAt: new Date(Date.now() - 36e5).toISOString(), updatedAt: now(), archivedAt: null, articleId: null, articleTitle: null, knowledgeBaseId: null, knowledgeBaseName: null },
  { id: "demo-note-2", contentMd: "> 我们不是通过收集来学习，而是通过建立联系来学习。\n\n读到这句话的时候，想起了自己的知识库。下次整理笔记时，试着为每条摘录写一句「它让我想到了什么」。", tags: ["阅读摘录"], pinned: false, version: 1, createdAt: new Date(Date.now() - 72e5).toISOString(), updatedAt: now(), archivedAt: null, articleId: null, articleTitle: null, knowledgeBaseId: null, knowledgeBaseName: null },
  { id: "demo-note-3", contentMd: "周末想做的小事\n\n- [ ] 整理 React 性能笔记\n- [ ] 把最近收藏的工具放进知识库\n- [x] 给今天的灵感留个位置", tags: ["生活", "待办"], pinned: false, version: 1, createdAt: new Date(Date.now() - 864e5).toISOString(), updatedAt: now(), archivedAt: null, articleId: null, articleTitle: null, knowledgeBaseId: null, knowledgeBaseName: null },
]
const requests = new Map<string, string>()
const ok = (data: unknown): DemoHandlerResult => ({ data: structuredClone(data) })
const fail = (msg: string, status = 400): DemoHandlerResult => ({ status, data: { code: status, msg } })
const text = (value: unknown) => typeof value === "string" ? value : ""

function content(body: Record<string, unknown>) {
  const contentMd = text(body.contentMd).trim()
  const tags = Array.isArray(body.tags) ? [...new Set(body.tags.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean))] : []
  if (!contentMd || Array.from(contentMd).length > 20000 || tags.length > 20 || tags.some((tag) => Array.from(tag).length > 80)) return null
  try {
    return { contentMd, tags, contentJson: richJSON(body.contentJson, false, 2 * 1024 * 1024), contentMetaJson: richJSON(body.contentMetaJson, true, 256 * 1024) }
  } catch { return null }
}

function richJSON(raw: unknown, meta: boolean, maxBytes: number): string | null {
  if (raw == null || raw === "") return null
  if (typeof raw !== "string" || new TextEncoder().encode(raw).length > maxBytes) throw new Error("富文本数据格式无效")
  if (!raw.trim()) return null
  const value: unknown = JSON.parse(raw)
  const object = value !== null && typeof value === "object" && !Array.isArray(value)
  if (meta ? !object : !Array.isArray(value) && !(object && "value" in value && Array.isArray(value.value))) throw new Error("富文本数据结构无效")
  return JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}

const handlers: Record<string, DemoHandler> = {
  "POST /inbox/recommendation/config": () => ok({ enabled: true, demo: true }),
  "POST /inbox/recommendation": (body) => {
    const note = notes.find((item) => item.id === body.id)
    if (!note) return fail("随笔不存在", 404)
    if (note.archivedAt || note.version !== body.version) return fail("随笔已归档或修改，请刷新后重新获取推荐", 409)
    // 明确标记的本地演示规则，用于体验完整交互，不冒充真实模型判断。
    const baseId = /React|TypeScript|前端|性能/i.test(note.contentMd) ? "demo-kb-engineering" : /阅读|读书|摘录|学习/.test(note.contentMd) ? "demo-kb-reading" : null
    const base = baseId ? kbById(baseId) : null
    const folder = base ? demoStore.nodes.find((node) => node.knowledgeBaseId === base.id && node.type === "FOLDER") : null
    const existingTags = [...new Set([...demoStore.articles.values()].flatMap((article) => article.tags))]
    const tags = existingTags.filter((tag) => !note.tags.includes(tag) && note.contentMd.toLowerCase().includes(tag.toLowerCase())).slice(0, Math.min(5, 20 - note.tags.length))
    const result: InboxArchiveRecommendation = {
      status: base ? "recommended" : "no_match", destination: base ? { knowledgeBaseId: base.id, knowledgeBaseName: base.name, parentId: folder?.id ?? null, folderPath: folder?.name ?? "知识库根目录" } : null,
      alternatives: [], tags, warnings: ["演示数据：不代表 Jev 的实际判断效果。"], confidence: 0, model: "demo", usage: { input_tokens: 0, output_tokens: 0 },
    }
    return ok(result)
  },
  "POST /inbox/list": (body) => {
    const status = text(body.status) || "inbox"
    if (!["inbox", "archived", "all"].includes(status)) return fail("随笔筛选状态无效")
    const keyword = text(body.keyword).trim().toLocaleLowerCase()
    const tag = text(body.tag)
    const filtered = notes.filter((note) => (status === "all" || Boolean(note.archivedAt) === (status === "archived")) && (!body.pinned || note.pinned) && (!tag || note.tags.includes(tag)) && note.contentMd.toLocaleLowerCase().includes(keyword))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const pageNum = Math.max(1, Math.floor(Number(body.pageNum) || 1))
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(body.pageSize) || 20)))
    const counts = new Map<string, number>()
    for (const note of notes) for (const value of note.tags) counts.set(value, (counts.get(value) ?? 0) + 1)
    const response: InboxListResponse = {
      rows: filtered.slice((pageNum - 1) * pageSize, pageNum * pageSize), total: filtered.length, pageNum, pageSize,
      summary: { total: notes.length, inbox: notes.filter((note) => !note.archivedAt).length, archived: notes.filter((note) => note.archivedAt).length },
      tags: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    }
    return ok(response)
  },
  "POST /inbox/create": (body) => {
    const value = content(body)
    const clientId = text(body.clientId)
    if (!value || !/^[a-zA-Z0-9_-]{8,80}$/.test(clientId)) return fail("随笔内容或请求标识无效")
    const existing = notes.find((note) => note.id === requests.get(clientId))
    if (existing) return existing.contentMd === value.contentMd && existing.contentJson === value.contentJson && existing.contentMetaJson === value.contentMetaJson && JSON.stringify(existing.tags) === JSON.stringify(value.tags) ? ok(existing) : fail("上一次记录已保存，请刷新查看；当前修改请保留后另行记录", 409)
    if (!validCaptureDemoSources(body.captureIds)) return fail("采集来源不存在、已删除或尚未完成")
    const note: InboxNote = { ...value, sources: captureDemoSources(body.captureIds), id: `demo-note-${crypto.randomUUID()}`, version: 1, pinned: false, createdAt: now(), updatedAt: now(), archivedAt: null, articleId: null, articleTitle: null, knowledgeBaseId: null, knowledgeBaseName: null }
    notes.unshift(note)
    requests.set(clientId, note.id)
    return ok(note)
  },
  "POST /inbox/update": (body) => {
    const note = notes.find((item) => item.id === body.id)
    if (!note) return fail("随笔不存在", 404)
    if (note.archivedAt || note.version !== body.version) return fail("随笔已归档或修改，请保留当前内容并刷新列表", 409)
    const value = content(body)
    if (!value) return fail("随笔内容或标签无效")
    Object.assign(note, value, { version: note.version + 1, updatedAt: now() })
    return ok(note)
  },
  "POST /inbox/pin": (body) => {
    const note = notes.find((item) => item.id === body.id)
    if (!note) return fail("随笔不存在", 404)
    if (typeof body.pinned !== "boolean") return fail("置顶状态无效")
    note.pinned = body.pinned
    return ok({ success: true })
  },
  "POST /inbox/delete": (body) => {
    const index = notes.findIndex((item) => item.id === body.id && item.version === body.version)
    if (index < 0) return fail("随笔已变更或不存在，请刷新后重试", 409)
    notes.splice(index, 1)
    return ok({ success: true })
  },
  "POST /inbox/archive": (body) => {
    const note = notes.find((item) => item.id === body.id)
    if (!note) return fail("随笔不存在", 404)
    if (note.archivedAt) return note.articleId && demoStore.articles.has(note.articleId) ? ok(note) : fail("归档文章已删除，随笔原文仍保留", 409)
    if (note.version !== body.version) return fail("随笔已修改，请刷新后重新归档", 409)
    const knowledgeBaseId = text(body.knowledgeBaseId)
    const base = kbById(knowledgeBaseId)
    if (!base) return fail("知识库不存在", 404)
    const parentId = text(body.parentId) || null
    if (parentId && !demoStore.nodes.some((node) => node.id === parentId && node.knowledgeBaseId === knowledgeBaseId && node.type === "FOLDER")) return fail("父节点必须是当前知识库下的文件夹")
    const title = text(body.title).trim()
    if (!title || Array.from(title).length > 200) return fail("文章标题须为 1 到 200 个字符")
    let tags = [...note.tags]
    if (body.tags !== undefined) {
      if (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === "string")) return fail("标签必须是字符串数组")
      tags = [...new Set((body.tags as string[]).map((tag) => tag.trim()).filter(Boolean))]
      const existing = new Set([...notes.flatMap((item) => item.tags), ...[...demoStore.articles.values()].flatMap((article) => article.tags)])
      if (tags.length > 20 || tags.some((tag) => Array.from(tag).length > 80 || !existing.has(tag))) return fail("请使用已有标签，且最多 20 个")
    }
    const nodeId = nextNodeId()
    const articleId = nextArticleId()
    demoStore.nodes.push({ id: nodeId, knowledgeBaseId, parentId, type: "ARTICLE", name: title, articleId, sortOrder: nodesOf(knowledgeBaseId, parentId).length })
    demoStore.articles.set(articleId, { articleId, nodeId, knowledgeBaseId, title, contentMd: note.contentMd, contentJson: note.contentJson ?? null, contentMetaJson: note.contentMetaJson ?? null, tags, createdAt: now(), updatedAt: now() })
    Object.assign(note, { archivedAt: now(), articleId, articleTitle: title, knowledgeBaseId, knowledgeBaseName: base.name, version: note.version + 1, pinned: false, updatedAt: now() })
    touchKb(knowledgeBaseId)
    return ok(note)
  },
}

export function resolveInboxDemoHandler(key: string) { return handlers[key] }
