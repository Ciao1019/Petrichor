// @vitest-environment jsdom
import * as React from "react"
import type { PlateContentState, PlateMarkdownEditor as EditorComponent, PlateMarkdownEditorHandle } from "@/components/plate/PlateMarkdownEditor"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { inboxApi, type InboxNote } from "@/lib/api"
import { InboxComposer } from "./InboxComposer"
import { inboxDraftKey } from "./inbox-utils"

vi.mock("@/lib/api", () => ({ inboxApi: { create: vi.fn(), update: vi.fn() } }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
const editorControl = vi.hoisted(() => ({ delayChange: false, pendingMedia: false }))
vi.mock("@/components/plate/PlateMarkdownEditor", async () => {
  const { forwardRef, useImperativeHandle, useRef, useState } = await import("react")
  return { PlateMarkdownEditor: forwardRef<PlateMarkdownEditorHandle, React.ComponentProps<typeof EditorComponent>>(function MockEditor(props, ref) {
    const [value, setValue] = useState(props.initialMarkdown)
    const latest = useRef<PlateContentState>({ markdown: props.initialMarkdown, contentJson: props.initialContentJson ?? "[]", contentMetaJson: props.initialContentMetaJson ?? "{}" })
    useImperativeHandle(ref, () => ({
      getContentState: () => { props.onContentStateChange?.(latest.current); return latest.current },
      hasPendingMedia: () => editorControl.pendingMedia,
      appendMarkdown: () => latest.current,
      importMarkdown: () => latest.current,
      importDocx: async () => ({ ...latest.current, commentsCount: 0, uploadedImageCount: 0, warnings: [] }),
    }))
    return <><textarea aria-label={props.ariaLabel} disabled={props.disabled} value={value} onChange={(event) => {
      setValue(event.target.value)
      latest.current = { markdown: event.target.value, contentJson: JSON.stringify([{ type: "p", children: [{ text: event.target.value, color: "#ff0000" }] }]), contentMetaJson: '{"discussions":[]}' }
      if (!editorControl.delayChange) props.onContentStateChange?.(latest.current)
    }} />{props.compactActions}</>
  }) }
})

beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); editorControl.delayChange = false; editorControl.pendingMedia = false })
afterEach(cleanup)

describe("随笔保存", () => {
  it("失败保留正文和请求标识，成功后才清空草稿", async () => {
    vi.mocked(inboxApi.create).mockRejectedValueOnce(new Error("offline"))
    const saved = vi.fn()
    render(<InboxComposer userId="alice" onSaved={saved} />)
    const editor = await screen.findByRole("textbox", { name: "随笔内容" })
    fireEvent.change(editor, { target: { value: "不会丢失的灵感" } })
    fireEvent.click(screen.getByRole("button", { name: "记下来" }))
    await screen.findByRole("alert")
    expect((editor as HTMLTextAreaElement).value).toBe("不会丢失的灵感")
    expect(saved).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(inboxDraftKey("alice"))!).contentJson).toContain("#ff0000")
    const request = vi.mocked(inboxApi.create).mock.calls[0]?.[0]
    expect(localStorage.getItem(inboxDraftKey("alice"))).toContain("不会丢失的灵感")
    vi.mocked(inboxApi.create).mockResolvedValueOnce({ data: { id: "1" } as InboxNote } as Awaited<ReturnType<typeof inboxApi.create>>)
    fireEvent.click(screen.getByRole("button", { name: "记下来" }))
    await waitFor(() => expect(saved).toHaveBeenCalledOnce())
    expect(vi.mocked(inboxApi.create).mock.calls[1]?.[0].clientId).toBe(request?.clientId)
    expect((await screen.findByRole("textbox", { name: "随笔内容" }) as HTMLTextAreaElement).value).toBe("")
    expect(localStorage.getItem(inboxDraftKey("alice"))).toBeNull()
    expect(vi.mocked(inboxApi.create).mock.calls[1]?.[0].contentJson).toContain("#ff0000")
  })

  it("草稿按用户隔离，重新打开同一用户时恢复", async () => {
    localStorage.setItem(inboxDraftKey("alice"), JSON.stringify({ contentMd: "Alice 私人草稿", tags: ["灵感"], clientId: "alice-draft-01" }))
    const first = render(<InboxComposer userId="bob" onSaved={vi.fn()} />)
    expect((await screen.findByRole("textbox", { name: "随笔内容" }) as HTMLTextAreaElement).value).toBe("")
    first.unmount()
    render(<InboxComposer userId="alice" onSaved={vi.fn()} />)
    expect((await screen.findByRole("textbox", { name: "随笔内容" }) as HTMLTextAreaElement).value).toBe("Alice 私人草稿")
  })

  it("提交期间重复快捷键不会重复保存", async () => {
    let finish!: (value: Awaited<ReturnType<typeof inboxApi.create>>) => void
    vi.mocked(inboxApi.create).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<InboxComposer userId="alice" onSaved={vi.fn()} />)
    const editor = await screen.findByRole("textbox", { name: "随笔内容" })
    fireEvent.change(editor, { target: { value: "快捷保存" } })
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true })
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true })
    expect(inboxApi.create).toHaveBeenCalledOnce()
    await act(async () => { finish({ data: { id: "1" } } as Awaited<ReturnType<typeof inboxApi.create>>) })
  })
})


it("立即快捷保存读取实时富文本，不依赖延迟草稿回调", async () => {
  editorControl.delayChange = true
  vi.mocked(inboxApi.create).mockResolvedValueOnce({ data: { id: "1" } as InboxNote } as Awaited<ReturnType<typeof inboxApi.create>>)
  render(<InboxComposer userId="alice" onSaved={vi.fn()} />)
  const editor = await screen.findByRole("textbox", { name: "随笔内容" })
  fireEvent.change(editor, { target: { value: "最后一次输入" } })
  fireEvent.keyDown(editor, { key: "Enter", metaKey: true })
  await waitFor(() => expect(inboxApi.create).toHaveBeenCalledWith(expect.objectContaining({ contentMd: "最后一次输入", contentJson: expect.stringContaining("#ff0000"), contentMetaJson: '{"discussions":[]}' })))
})

it("附件占位符尚未完成时阻止快捷保存", async () => {
  editorControl.pendingMedia = true
  render(<InboxComposer userId="alice" onSaved={vi.fn()} />)
  const editor = await screen.findByRole("textbox", { name: "随笔内容" })
  fireEvent.change(editor, { target: { value: "带附件的随笔" } })
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true })
  expect((await screen.findByRole("alert")).textContent).toContain("请等待附件上传完成")
  expect(inboxApi.create).not.toHaveBeenCalled()
})

it("恢复本地富文本草稿后保存仍携带样式和批注", async () => {
  const richDraft = { contentMd: "恢复的随笔", contentJson: '[{"type":"p","children":[{"text":"恢复的随笔","bold":true}]}]', contentMetaJson: '{"discussions":[{"id":"comment-1"}]}', tags: ["灵感"], clientId: "restore-rich-draft" }
  localStorage.setItem(inboxDraftKey("alice"), JSON.stringify(richDraft))
  vi.mocked(inboxApi.create).mockResolvedValueOnce({ data: { id: "1" } as InboxNote } as Awaited<ReturnType<typeof inboxApi.create>>)
  render(<InboxComposer userId="alice" onSaved={vi.fn()} />)
  await screen.findByRole("textbox", { name: "随笔内容" })
  fireEvent.click(screen.getByRole("button", { name: "记下来" }))
  await waitFor(() => expect(inboxApi.create).toHaveBeenCalledWith(richDraft))
})
