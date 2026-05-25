import { describe, expect, it } from "vitest"

import {
    isDescendantKnowledgeBaseNode,
    moveNodeIdIntoSiblingOrder,
} from "@/server/kb/node-move-logic"

describe("knowledge base node move helpers", () => {
    it("按目标下标把节点插入同级顺序", () => {
        expect(moveNodeIdIntoSiblingOrder([1, 2, 3, 4], 1, 2)).toEqual([2, 3, 1, 4])
        expect(moveNodeIdIntoSiblingOrder([1, 2, 3, 4], 4, 1)).toEqual([1, 4, 2, 3])
        expect(moveNodeIdIntoSiblingOrder([1, 2], 3, undefined)).toEqual([1, 2, 3])
    })

    it("将越界目标下标限制在可用范围内", () => {
        expect(moveNodeIdIntoSiblingOrder([1, 2, 3], 2, -1)).toEqual([2, 1, 3])
        expect(moveNodeIdIntoSiblingOrder([1, 2, 3], 2, 99)).toEqual([1, 3, 2])
    })

    it("识别目标父级是否在当前文件夹的子树中", () => {
        const nodes = [
            { id: 1, parentId: null },
            { id: 2, parentId: 1 },
            { id: 3, parentId: 2 },
            { id: 4, parentId: null },
        ]

        expect(isDescendantKnowledgeBaseNode(nodes, 1, 3)).toBe(true)
        expect(isDescendantKnowledgeBaseNode(nodes, 2, 3)).toBe(true)
        expect(isDescendantKnowledgeBaseNode(nodes, 3, 3)).toBe(true)
        expect(isDescendantKnowledgeBaseNode(nodes, 3, 1)).toBe(false)
        expect(isDescendantKnowledgeBaseNode(nodes, 1, 4)).toBe(false)
        expect(isDescendantKnowledgeBaseNode(nodes, 1, null)).toBe(false)
    })
})
