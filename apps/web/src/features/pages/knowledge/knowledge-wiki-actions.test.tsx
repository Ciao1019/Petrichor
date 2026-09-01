// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 「编译说明书」按钮的点击链路测试。
 *
 * 验证的是从点按钮到落库这一条：懒加载弹窗 → 读取接口 → 未保存时用模板起手 →
 * 保存后回报启用状态。之前有过把 UI 加到不可达页面的教训，这里用真实渲染断言，
 * 而不是靠类型检查证明「能用」。
 */

const guide = vi.fn()
const saveGuide = vi.fn()
const lint = vi.fn()

vi.mock("@/lib/api", () => ({
    knowledgeBaseWikiAgentApi: {
        guide: (...args: unknown[]) => guide(...args),
        saveGuide: (...args: unknown[]) => saveGuide(...args),
        lint: (...args: unknown[]) => lint(...args),
    },
    exportKnowledgeBaseWikiBundle: vi.fn(),
    exportKnowledgeBaseSkillPack: vi.fn(),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { KnowledgeWikiActions } = await import("./KnowledgeWikiActions")

/** 点击后把懒加载与状态更新都冲干净，避免断言跑在 Suspense 解析之前。 */
async function click(element: HTMLElement) {
    await act(async () => {
        fireEvent.click(element)
        await Promise.resolve()
    })
}

const TEMPLATE = "# 编译说明书\n\n<!-- 示例 -->\n\n## 抽取偏好\n"

beforeEach(() => {
    guide.mockReset()
    saveGuide.mockReset()
    lint.mockReset()
    lint.mockResolvedValue({ data: { issues: [] } })
})

afterEach(cleanup)

describe("点击编译说明书", () => {
    it("未保存过时懒加载弹窗并用模板起手", async () => {
        guide.mockResolvedValue({
            data: {
                knowledgeBaseId: "1", pageKey: "compile-guide", enabled: false,
                contentMd: "", templateMd: TEMPLATE, maxLength: 8000,
            },
        })
        render(<KnowledgeWikiActions knowledgeBaseId="1" pageCount={12} />)

        // 点击之前不应该请求说明书，也不该把弹窗的代码拉下来。
        expect(guide).not.toHaveBeenCalled()

        await click(screen.getByRole("button", { name: /编译说明书/ }))

        await waitFor(() => expect(guide).toHaveBeenCalledWith("1"))
        const textarea = await screen.findByRole("textbox")
        expect((textarea as HTMLTextAreaElement).value).toBe(TEMPLATE)
        expect(screen.getByText(/只能细化领域偏好/)).toBeTruthy()
    })

    it("已保存过时回填已有内容并显示已启用徽标", async () => {
        guide.mockResolvedValue({
            data: {
                knowledgeBaseId: "1", pageKey: "compile-guide", enabled: true,
                contentMd: "## 抽取偏好\n\n- 命令抽成 concept。", templateMd: TEMPLATE, maxLength: 8000,
            },
        })
        render(<KnowledgeWikiActions knowledgeBaseId="1" pageCount={12} />)
        await click(screen.getByRole("button", { name: /编译说明书/ }))

        const textarea = await screen.findByRole("textbox")
        expect((textarea as HTMLTextAreaElement).value).toContain("命令抽成 concept")
        await waitFor(() => expect(screen.getByText("已启用")).toBeTruthy())
    })

    it("保存把草稿发给接口并关闭弹窗", async () => {
        guide.mockResolvedValue({
            data: {
                knowledgeBaseId: "1", pageKey: "compile-guide", enabled: false,
                contentMd: "", templateMd: "", maxLength: 8000,
            },
        })
        saveGuide.mockResolvedValue({
            data: { knowledgeBaseId: "1", pageKey: "compile-guide", enabled: true, contentMd: "只抽命令" },
        })
        render(<KnowledgeWikiActions knowledgeBaseId="1" pageCount={12} />)
        await click(screen.getByRole("button", { name: /编译说明书/ }))

        const textarea = await screen.findByRole("textbox")
        fireEvent.change(textarea, { target: { value: "只抽命令" } })
        await click(screen.getByRole("button", { name: "保存" }))

        await waitFor(() => expect(saveGuide).toHaveBeenCalledWith("1", "只抽命令"))
        await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
        expect(screen.getByText("已启用")).toBeTruthy()
    })

    it("读取失败时关掉弹窗，不把用户卡在空白框里", async () => {
        guide.mockRejectedValue(new Error("boom"))
        render(<KnowledgeWikiActions knowledgeBaseId="1" pageCount={12} />)
        await click(screen.getByRole("button", { name: /编译说明书/ }))

        await waitFor(() => expect(guide).toHaveBeenCalled())
        await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull())
    })
})
