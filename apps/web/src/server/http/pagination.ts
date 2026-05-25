export interface PaginationInput {
    pageNum?: number
    pageSize?: number
    isAsc?: string
}

export function resolvePagination(input: PaginationInput) {
    const pageNum = Number.isInteger(input.pageNum) && input.pageNum && input.pageNum > 0
        ? input.pageNum
        : 1
    const pageSize = Number.isInteger(input.pageSize) && input.pageSize && input.pageSize > 0
        ? Math.min(input.pageSize, 100)
        : 20

    return {
        limit: pageSize,
        offset: (pageNum - 1) * pageSize,
        asc: input.isAsc === "asc" || input.isAsc === "true",
    }
}
