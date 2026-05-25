type KnowledgeBaseNodePosition = {
    id: number
    parentId: number | null
}

export function isDescendantKnowledgeBaseNode(
    nodes: KnowledgeBaseNodePosition[],
    ancestorId: number,
    nodeId: number | null,
) {
    if (nodeId == null) {
        return false
    }

    const parentByNodeId = new Map(nodes.map((node) => [node.id, node.parentId]))
    const visited = new Set<number>()
    let currentId: number | null | undefined = nodeId

    while (currentId != null && !visited.has(currentId)) {
        if (currentId === ancestorId) {
            return true
        }
        visited.add(currentId)
        currentId = parentByNodeId.get(currentId)
    }

    return false
}

export function moveNodeIdIntoSiblingOrder(
    siblingIds: number[],
    movingNodeId: number,
    targetIndex: number | undefined,
) {
    const withoutMoving = siblingIds.filter((id) => id !== movingNodeId)
    const safeIndex = Math.max(0, Math.min(targetIndex ?? withoutMoving.length, withoutMoving.length))
    return [
        ...withoutMoving.slice(0, safeIndex),
        movingNodeId,
        ...withoutMoving.slice(safeIndex),
    ]
}
