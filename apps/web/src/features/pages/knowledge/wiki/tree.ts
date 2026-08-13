/**
 * 把扁平的 Wiki 页面列表按 categoryPath 组装成目录树。
 *
 * 页面的 categoryPath 是后端在构建阶段规划出的目录链（例如 ["软件","命令行工具"]），
 * 空数组表示挂在根目录下。目录节点本身不存库，完全由页面路径推导出来。
 */

import type { KnowledgeBaseWikiPageResponse } from "@/lib/api"

export interface WikiTreeFolder {
    type: "folder"
    /** 从根目录到当前目录的完整路径，用 "/" 连接，作为稳定的 React key 和展开状态键。 */
    id: string
    name: string
    depth: number
    children: WikiTreeNode[]
    /** 子树里的页面总数（含所有下级目录）。 */
    pageCount: number
}

export interface WikiTreePage {
    type: "page"
    id: string
    depth: number
    page: KnowledgeBaseWikiPageResponse
}

export type WikiTreeNode = WikiTreeFolder | WikiTreePage

/** 索引页固定置顶，其余按类型再按标题排序，和目录树里的页面顺序保持一致。 */
const KIND_ORDER: Record<string, number> = { index: 0, summary: 1, entity: 2, concept: 3 }

function comparePages(left: KnowledgeBaseWikiPageResponse, right: KnowledgeBaseWikiPageResponse): number {
    if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder
    const leftKind = KIND_ORDER[left.kind] ?? 9
    const rightKind = KIND_ORDER[right.kind] ?? 9
    if (leftKind !== rightKind) return leftKind - rightKind
    return left.title.localeCompare(right.title, "zh-Hans-CN")
}

/**
 * 目录名排序：拉丁字母开头的目录排在中文目录前面，其余按拼音。
 * zh-Hans-CN 的默认排序会把汉字排在拉丁字母之前，导致 "Shell" 这类目录沉到底部；
 * 显式提前更符合阅读习惯，也和参考实现的目录顺序一致。
 */
function compareFolderNames(left: string, right: string): number {
    const leftLatin = /^[\x20-\x7e]/.test(left)
    const rightLatin = /^[\x20-\x7e]/.test(right)
    if (leftLatin !== rightLatin) return leftLatin ? -1 : 1
    return left.localeCompare(right, "zh-Hans-CN")
}

interface MutableFolder {
    name: string
    path: string[]
    folders: Map<string, MutableFolder>
    pages: KnowledgeBaseWikiPageResponse[]
}

function emptyFolder(name: string, path: string[]): MutableFolder {
    return { name, path, folders: new Map(), pages: [] }
}

/**
 * 组装目录树。索引页（kind === "index"）始终留在根目录，它是整个 Wiki 的入口，
 * 归到某个业务目录下反而会被埋起来。
 */
export function buildWikiTree(pages: KnowledgeBaseWikiPageResponse[]): WikiTreeNode[] {
    const root = emptyFolder("", [])
    for (const page of pages) {
        const path = page.kind === "index" ? [] : (page.categoryPath ?? []).filter((part) => part.trim() !== "")
        let current = root
        for (const label of path) {
            let child = current.folders.get(label)
            if (!child) {
                child = emptyFolder(label, [...current.path, label])
                current.folders.set(label, child)
            }
            current = child
        }
        current.pages.push(page)
    }
    return materialize(root, 0).children
}

function materialize(folder: MutableFolder, depth: number): WikiTreeFolder {
    const childFolders = [...folder.folders.values()]
        .map((child) => materialize(child, depth + 1))
        .sort((left, right) => compareFolderNames(left.name, right.name))
    const childPages: WikiTreePage[] = [...folder.pages].sort(comparePages).map((page) => ({
        type: "page",
        id: page.pageKey,
        depth,
        page,
    }))
    // 目录排在页面前面，和文件管理器一致。
    const children: WikiTreeNode[] = [...childFolders, ...childPages]
    const pageCount = childFolders.reduce((total, child) => total + child.pageCount, 0) + childPages.length
    return {
        type: "folder",
        id: folder.path.join("/"),
        name: folder.name,
        depth: depth - 1,
        children,
        pageCount,
    }
}

/**
 * 按关键字过滤页面，并保留命中页面所在的目录链，这样搜索结果仍然带着上下文，
 * 而不是塌成一个扁平列表。
 */
export function filterWikiPages(pages: KnowledgeBaseWikiPageResponse[], search: string): KnowledgeBaseWikiPageResponse[] {
    const needle = search.trim().toLocaleLowerCase()
    if (!needle) return pages
    return pages.filter((page) => {
        const haystack = `${page.title} ${page.summary ?? ""} ${(page.categoryPath ?? []).join(" ")}`
        return haystack.toLocaleLowerCase().includes(needle)
    })
}

/** 收集目录树里所有目录节点的 id，用于「全部展开」。 */
export function collectFolderIds(nodes: WikiTreeNode[]): string[] {
    const ids: string[] = []
    const walk = (items: WikiTreeNode[]) => {
        for (const item of items) {
            if (item.type !== "folder") continue
            ids.push(item.id)
            walk(item.children)
        }
    }
    walk(nodes)
    return ids
}

/** 找到某个页面所在的全部祖先目录 id，用于选中页面时自动展开到它。 */
export function folderIdsForPage(page: KnowledgeBaseWikiPageResponse | undefined): string[] {
    if (!page || page.kind === "index") return []
    const path = (page.categoryPath ?? []).filter((part) => part.trim() !== "")
    return path.map((_, index) => path.slice(0, index + 1).join("/"))
}
