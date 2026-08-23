package httpx

import (
	"math"
)

// PaginationInput 对应 src/server/http/pagination.ts。
type PaginationInput struct {
	PageNum  *int64  `json:"pageNum"`
	PageSize *int64  `json:"pageSize"`
	IsAsc    *string `json:"isAsc"`
}

type Pagination struct {
	Limit  int64
	Offset int64
	Asc    bool
}

// ResolvePagination 复刻 resolvePagination：pageSize 上限 100、默认 20。
func ResolvePagination(input PaginationInput) Pagination {
	pageNum := int64(1)
	if input.PageNum != nil && isPositiveInt(*input.PageNum) {
		pageNum = *input.PageNum
	}
	pageSize := int64(20)
	if input.PageSize != nil && isPositiveInt(*input.PageSize) {
		pageSize = min64(*input.PageSize, 100)
	}
	asc := false
	if input.IsAsc != nil {
		asc = *input.IsAsc == "asc" || *input.IsAsc == "true"
	}
	return Pagination{
		Limit:  pageSize,
		Offset: (pageNum - 1) * pageSize,
		Asc:    asc,
	}
}

func isPositiveInt(n int64) bool {
	return n > 0 && n <= math.MaxInt32
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
