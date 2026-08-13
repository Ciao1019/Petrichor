package pagination

// Input 对齐前端 pageNum/pageSize/isAsc 约定。
type Input struct {
	PageNum  int    `json:"pageNum"`
	PageSize int    `json:"pageSize"`
	IsAsc    string `json:"isAsc"`
}

type Result struct {
	Limit  int
	Offset int
	Asc    bool
}

func Resolve(input Input) Result {
	pageNum := input.PageNum
	if pageNum <= 0 {
		pageNum = 1
	}
	pageSize := input.PageSize
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return Result{
		Limit:  pageSize,
		Offset: (pageNum - 1) * pageSize,
		Asc:    input.IsAsc == "asc" || input.IsAsc == "true",
	}
}
