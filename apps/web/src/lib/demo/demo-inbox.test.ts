import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InboxArchiveRecommendation, InboxNote } from "@/lib/api-inbox"

async function setup() {
  const { resolveInboxDemoHandler } = await import("./demo-inbox")
  const { demoStore } = await import("./demo-store")
  const call = (path: string, body: Record<string, unknown>) => {
    const handler = resolveInboxDemoHandler(`POST /inbox/${path}`)
    if (!handler) throw new Error(`Missing handler ${path}`)
    return handler(body)
  }
  return { call, demoStore }
}
beforeEach(() => vi.resetModules())

it("推荐明确标记为演示，采纳标签只写入归档文章", async () => {
  const { call, demoStore } = await setup()
  const note = call("create", { clientId: "recommend-test-demo", contentMd: "React 性能优化笔记", tags: ["随手记"] }).data as InboxNote
  const result = call("recommendation", { id: note.id, version: note.version }).data as InboxArchiveRecommendation
  expect(result.status).toBe("recommended")
  expect(result.model).toBe("demo")
  expect(result.tags).toContain("React")
  expect(result.warnings.join("")).toContain("演示数据")
  const archive = { id: note.id, version: note.version, title: "React 笔记", knowledgeBaseId: result.destination!.knowledgeBaseId, parentId: result.destination!.parentId, tags: [...note.tags, ...result.tags] }
  expect(call("archive", { ...archive, tags: ["不存在的新标签"] }).status).toBe(400)
  const saved = call("archive", archive).data as InboxNote
  expect(saved.tags).toEqual(["随手记"])
  expect(demoStore.articles.get(saved.articleId!)?.tags).toContain("React")
  expect(call("recommendation", { id: note.id, version: note.version }).status).toBe(409)
})

describe("随笔演示完整流程", () => {
  it("重试不重复创建，变化的正文不会被静默丢弃", async () => {
    const { call } = await setup()
    const input = { clientId: "demo-retry-test", contentMd: "100% 灵感", tags: ["验收"] }
    const one = call("create", input).data as InboxNote
    const two = call("create", input).data as InboxNote
    expect(one.id).toBe(two.id)
    expect(call("create", { ...input, contentMd: "另一条" }).status).toBe(409)
    expect(call("list", { keyword: "%", tag: "验收" }).data).toMatchObject({ total: 1 })
  })

  it("归档带入正文和标签，再次归档复用文章；删除记录不删除文章", async () => {
    const { call, demoStore } = await setup()
    const note = call("create", { clientId: "demo-archive-test", contentMd: "## 想法\n\n正文", tags: ["阅读"] }).data as InboxNote
    const base = demoStore.knowledgeBases[0]!
    const input = { id: note.id, version: note.version, title: "归档标题", knowledgeBaseId: base.id, parentId: null }
    const result = call("archive", input).data as InboxNote
    expect(result.archivedAt).toBeTruthy()
    expect(demoStore.articles.get(result.articleId!)).toMatchObject({ contentMd: note.contentMd, tags: ["阅读"], title: "归档标题" })
    expect((call("archive", input).data as InboxNote).articleId).toBe(result.articleId)
    expect(call("delete", { id: note.id, version: result.version }).status).toBeUndefined()
    expect(demoStore.articles.has(result.articleId!)).toBe(true)
  })

  it("拒绝错误文件夹，失败保留待整理状态", async () => {
    const { call, demoStore } = await setup()
    const note = call("create", { clientId: "demo-folder-test", contentMd: "归档保留原文", tags: [] }).data as InboxNote
    const before = demoStore.articles.size
    expect(call("archive", { id: note.id, version: note.version, title: "标题", knowledgeBaseId: demoStore.knowledgeBases[0]!.id, parentId: "missing-folder" }).status).toBe(400)
    expect(demoStore.articles.size).toBe(before)
    expect(call("list", { status: "inbox", keyword: "归档保留原文" }).data).toMatchObject({ total: 1 })
  })
})

it("富文本样式和批注在编辑、查询及归档后完整保留", async () => {
  const { call, demoStore } = await setup()
  const contentJson = JSON.stringify([{ type: "p", children: [{ text: "彩色随笔", color: "#ff0000", underline: true }] }])
  const contentMetaJson = JSON.stringify({ currentUserId: "demo", discussions: [{ id: "discussion-1", comments: [] }], users: {} })
  const created = call("create", { clientId: "rich-note-test", contentMd: "彩色随笔", contentJson, contentMetaJson, tags: [] }).data as InboxNote
  const updated = call("update", { id: created.id, version: created.version, contentMd: "彩色随笔", contentJson, contentMetaJson, tags: ["富文本"] }).data as InboxNote
  const list = call("list", { keyword: "彩色随笔" }).data as { rows: InboxNote[] }
  expect(JSON.parse(list.rows[0]!.contentJson!)).toEqual(JSON.parse(contentJson))
  expect(JSON.parse(list.rows[0]!.contentMetaJson!)).toEqual(JSON.parse(contentMetaJson))
  const archived = call("archive", { id: updated.id, version: updated.version, knowledgeBaseId: demoStore.knowledgeBases[0]!.id, title: "保留样式", parentId: null }).data as InboxNote
  expect(demoStore.articles.get(archived.articleId!)).toMatchObject({ contentJson: updated.contentJson, contentMetaJson: updated.contentMetaJson })
})

it("同一请求只修改格式或批注时不能静默返回旧内容", async () => {
  const { call } = await setup()
  const input = { clientId: "rich-retry-test", contentMd: "相同正文", contentJson: '[{"type":"p","children":[{"text":"相同正文"}]}]', contentMetaJson: "{}", tags: [] }
  const created = call("create", input).data as InboxNote
  expect((call("create", { ...input, contentJson: '[ { "children": [{"text":"相同正文"}], "type": "p" } ]' }).data as InboxNote).id).toBe(created.id)
  expect(call("create", { ...input, contentJson: '[{"type":"p","children":[{"text":"相同正文","bold":true}]}]' }).status).toBe(409)
  expect(call("create", { ...input, contentMetaJson: '{"discussions":[{"id":"new"}]}' }).status).toBe(409)
})
