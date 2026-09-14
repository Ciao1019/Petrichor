package kb

import "fmt"

// validateImportFinalization 成文前再次校验完整页集，不能把缺页或预留 ID 当成功。
func validateImportFinalization(job *JobRow, pages []JobPageRow) error {
	if len(pages) == 0 || len(pages) != int(job.TotalPages) || len(pages) > maxImportPages {
		return badReq("任务页面不完整，无法合并")
	}
	if notDone := countNotDonePages(pages); notDone > 0 {
		return badReq(fmt.Sprintf("仍有 %d 页未成功转换，请先重试失败页", notDone))
	}
	totalBytes := 0
	for i, page := range pages {
		if page.PageNo != int32(i+1) {
			return badReq("任务页码不连续，无法合并")
		}
		size := len(derefStr(page.Markdown))
		if size > maxImportPageMarkdownBytes {
			return badReq("单页 Markdown 超过 2MB")
		}
		totalBytes += size
		if totalBytes > maxImportMarkdownBytes {
			return badReq("Markdown 总量超过 16MB")
		}
	}
	return nil
}
