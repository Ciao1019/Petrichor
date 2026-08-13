import { describe, expect, it } from "vitest"

import type { KnowledgeBaseWikiPageResponse } from "@/lib/api"
import { buildWikiTree, collectFolderIds, filterWikiPages, folderIdsForPage, type WikiTreeFolder } from "./tree"

function page(
    pageKey: string,
    title: string,
    kind: KnowledgeBaseWikiPageResponse["kind"],
    categoryPath: string[],
): KnowledgeBaseWikiPageResponse {
    return {
        id: pageKey, knowledgeBaseId: "kb-1", pageKey, title, kind, contentMd: `# ${title}`,
        frontmatter: {}, summary: null, contentHash: pageKey, categoryPath, sortOrder: 0,
        version: 1, archivedAt: null, createdAt: null, updatedAt: null,
    }
}

const pages = [
    page("entity/zsh", "Zsh", "entity", ["软件", "Shell"]),
    page("index", "索引", "index", []),
    page("entity/bash", "Bash", "entity", ["软件", "Shell"]),
    page("concept/cleanup", "系统清理", "concept", ["系统维护"]),
    page("entity/mole", "小鼹鼠", "entity", ["软件", "清理工具"]),
    page("summary/readme", "README.md - Summary", "summary", []),
]

describe("buildWikiTree", () => {
    it("按 categoryPath 把页面归入多级目录，并统计子树页面数", () => {
        const tree = buildWikiTree(pages)
        const folders = tree.filter((node): node is WikiTreeFolder => node.type === "folder")

        // 目录名按拼音排序：软件 (ruǎn) 在 系统维护 (xì) 之前。
        expect(folders.map((folder) => folder.name)).toEqual(["软件", "系统维护"])
        const software = folders.find((folder) => folder.name === "软件")!
        expect(software.pageCount).toBe(3)
        expect(software.children.map((child) => (child.type === "folder" ? child.name : child.page.title)))
            .toEqual(["Shell", "清理工具"])

        const shell = software.children.find((child) => child.type === "folder" && child.name === "Shell") as WikiTreeFolder
        expect(shell.pageCount).toBe(2)
        expect(shell.children.map((child) => (child.type === "page" ? child.page.title : ""))).toEqual(["Bash", "Zsh"])
    })

    it("目录排在页面前面，索引页留在根目录并置顶", () => {
        const tree = buildWikiTree(pages)
        const rootPages = tree.filter((node) => node.type === "page")

        expect(tree.at(0)?.type).toBe("folder")
        expect(rootPages.map((node) => (node.type === "page" ? node.page.title : ""))).toEqual(["索引", "README.md - Summary"])
    })

    it("索引页即使带了 categoryPath 也不会被埋进目录", () => {
        const tree = buildWikiTree([page("index", "索引", "index", ["软件"])])

        expect(tree).toHaveLength(1)
        expect(tree[0]!.type).toBe("page")
    })

    it("categoryPath 为空的页面挂在根目录", () => {
        const tree = buildWikiTree([page("entity/x", "X", "entity", [])])

        expect(tree.map((node) => node.type)).toEqual(["page"])
    })

    it("忽略 categoryPath 里的空白标签", () => {
        const tree = buildWikiTree([page("entity/x", "X", "entity", ["软件", "  "])])
        const folders = tree.filter((node): node is WikiTreeFolder => node.type === "folder")

        expect(folders).toHaveLength(1)
        expect(folders[0]!.children.map((child) => child.type)).toEqual(["page"])
    })
})

describe("filterWikiPages", () => {
    it("空关键字返回原列表", () => {
        expect(filterWikiPages(pages, "  ")).toBe(pages)
    })

    it("匹配标题、摘要与目录名", () => {
        expect(filterWikiPages(pages, "zsh").map((item) => item.title)).toEqual(["Zsh"])
        expect(filterWikiPages(pages, "shell").map((item) => item.title)).toEqual(["Zsh", "Bash"])
    })
})

describe("collectFolderIds / folderIdsForPage", () => {
    it("收集全部目录 id", () => {
        expect(collectFolderIds(buildWikiTree(pages)).sort()).toEqual(["系统维护", "软件", "软件/Shell", "软件/清理工具"].sort())
    })

    it("给出页面的祖先目录链", () => {
        expect(folderIdsForPage(pages[0])).toEqual(["软件", "软件/Shell"])
        expect(folderIdsForPage(pages[1])).toEqual([])
        expect(folderIdsForPage(undefined)).toEqual([])
    })
})
