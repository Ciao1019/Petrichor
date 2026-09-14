// import.go 提供视觉导入的输入解析、Redis 状态组装与模型选择逻辑。
package kb

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"petrichor/api/internal/taskqueue"
)

const (
	defaultImportConcurrency = 4
	maxImportConcurrency     = 8
)

func parseCreateJobInput(raw map[string]any) (kbID int64, parentID *int64, fileName, title, sourceKey string, modelConfigID *int64, err error) {
	kbID, err = reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
	if err != nil {
		return
	}
	parentID = parseOptionalID(raw, "parentId")
	fileName = trimmedString(raw, "fileName")
	if fileName == "" || len([]rune(fileName)) > 500 {
		err = badReq("fileName 必须在 1 到 500 个字符之间")
		return
	}
	title, err = parseTitleField(raw, 200)
	if err != nil {
		return
	}
	sourceKey = trimmedString(raw, "sourceKey")
	if sourceKey == "" {
		err = badReq("sourceKey 不能为空")
		return
	}
	modelConfigID = parseOptionalID(raw, "modelConfigId")
	return
}

func parsePositiveInt(raw any) (int64, error) {
	switch value := raw.(type) {
	case string:
		n, err := strconv.ParseInt(trimSpace(value), 10, 64)
		if err != nil || n <= 0 {
			return 0, badReq("必须是正整数")
		}
		return n, nil
	case float64:
		n := int64(value)
		if value <= 0 || float64(n) != value {
			return 0, badReq("必须是正整数")
		}
		return n, nil
	default:
		return 0, badReq("必须是正整数")
	}
}

func resolveImportConcurrency(raw map[string]any) int32 {
	value, ok := raw["concurrency"].(float64)
	if !ok || value <= 0 {
		return defaultImportConcurrency
	}
	resolved := int(value)
	if resolved > maxImportConcurrency {
		resolved = maxImportConcurrency
	}
	if resolved < 1 {
		resolved = 1
	}
	return int32(resolved)
}

func loadJobOwned(ctx context.Context, userID, jobID int64) (*JobRow, error) {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return nil, err
	}
	job, err := store.GetOwned(ctx, userID, jobID)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return nil, notFoundErr("导入任务不存在")
	}
	return job, err
}

func loadJobByID(ctx context.Context, jobID int64) (*JobRow, error) {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return nil, err
	}
	return store.Get(ctx, jobID)
}

func loadJobPages(ctx context.Context, jobID int64) ([]JobPageRow, error) {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return nil, err
	}
	return store.Pages(ctx, jobID)
}

func loadJobPage(ctx context.Context, jobID, pageNo int64) (*JobPageRow, error) {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return nil, err
	}
	page, err := store.Page(ctx, jobID, pageNo)
	if errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		return nil, notFoundErr("导入任务页不存在")
	}
	return page, err
}

type importPageStats struct {
	donePages       int32
	failedPages     int32
	pendingPages    int32
	deadLetterPages int32
	directPages     int32
	multimodalPages int32
	actualMethods   []string
}

func emptyPageStats(totalPages int32) importPageStats {
	return importPageStats{pendingPages: totalPages}
}

func buildPageStats(pages []JobPageRow) importPageStats {
	stats := importPageStats{actualMethods: []string{}}
	methods := map[string]bool{}
	for i := range pages {
		page := pages[i]
		switch page.Status {
		case "done":
			stats.donePages++
			switch page.ExtractedBy {
			case "multimodal":
				stats.multimodalPages++
			default:
				stats.directPages++
			}
			if !methods[page.ExtractedBy] {
				methods[page.ExtractedBy] = true
				stats.actualMethods = append(stats.actualMethods, page.ExtractedBy)
			}
		case "failed":
			stats.failedPages++
		case "dead_letter":
			stats.failedPages++
			stats.deadLetterPages++
		default:
			stats.pendingPages++
		}
	}
	return stats
}

func toJobResponse(job *JobRow, extraKBName, extraFolderName *string, stats *importPageStats) map[string]any {
	pageStats := emptyPageStats(job.TotalPages)
	if stats != nil {
		pageStats = *stats
	}
	status := job.Status
	if status == "completed" && job.ArticleID == nil {
		status = "processing"
	}
	return map[string]any{
		"id":                   strconv.FormatInt(job.ID, 10),
		"knowledgeBaseId":      strconv.FormatInt(job.KnowledgeBaseID, 10),
		"knowledgeBaseName":    extraKBName,
		"parentNodeId":         nullableIDString(job.ParentNodeID),
		"parentFolderName":     extraFolderName,
		"sourceType":           job.SourceType,
		"imagePolicy":          taskqueue.EffectiveDocumentImagePolicy(job.ImagePolicy),
		"pageUnit":             job.PageUnit,
		"actualMethods":        append([]string{}, pageStats.actualMethods...),
		"directPages":          pageStats.directPages,
		"multimodalPages":      pageStats.multimodalPages,
		"fileName":             job.FileName,
		"title":                job.Title,
		"totalPages":           job.TotalPages,
		"processedPages":       job.ProcessedPages,
		"donePages":            pageStats.donePages,
		"failedPages":          pageStats.failedPages,
		"pendingPages":         pageStats.pendingPages,
		"status":               status,
		"stage":                job.Stage,
		"prepareAttempt":       job.PrepareAttempt,
		"prepareMaxAttempts":   job.PrepareMaxAttempts,
		"prepareNextAttemptAt": iso(job.PrepareNextAttemptAt),
		"modelConfigId":        nullableIDString(job.ModelConfigID),
		"articleId":            nullableIDString(job.ArticleID),
		"error":                job.Error,
		"deadLetteredAt":       isoPtr(job.DeadLetteredAt),
		"replayCount":          job.ReplayCount,
		"createdAt":            iso(job.CreatedAt),
		"updatedAt":            iso(job.UpdatedAt),
	}
}

func toPageResponse(page *JobPageRow) map[string]any {
	return map[string]any{
		"pageNo":         page.PageNo,
		"imageKey":       page.ImageKey,
		"assets":         page.Assets,
		"extractedBy":    page.ExtractedBy,
		"status":         page.Status,
		"markdown":       page.Markdown,
		"error":          page.Error,
		"attemptCount":   page.AttemptCount,
		"maxAttempts":    page.MaxAttempts,
		"nextAttemptAt":  iso(page.NextAttemptAt),
		"lastError":      page.LastError,
		"deadLetteredAt": isoPtr(page.DeadLetteredAt),
	}
}

// loadJobDecorations 只从 PostgreSQL 读取知识库/目录业务名称；任务和页状态来自 Redis。
func loadJobDecorations(ctx context.Context, q execQuerier, userID int64, jobs []*JobRow) (map[int64]struct {
	kbName     *string
	folderName *string
	stats      importPageStats
}, error) {
	result := map[int64]struct {
		kbName     *string
		folderName *string
		stats      importPageStats
	}{}
	if len(jobs) == 0 {
		return result, nil
	}
	kbIDs := map[int64]struct{}{}
	for _, job := range jobs {
		kbIDs[job.KnowledgeBaseID] = struct{}{}
	}
	kbNames, err := loadIDNameMap(ctx, q,
		`SELECT id, name FROM petrichor_kb_knowledge_base WHERE user_id = $1 AND id = ANY($2)`,
		userID, setToSortedSlice(kbIDs))
	if err != nil {
		return nil, err
	}
	var parentNodeIDs []int64
	for _, job := range jobs {
		if job.ParentNodeID != nil {
			parentNodeIDs = append(parentNodeIDs, *job.ParentNodeID)
		}
	}
	folderNames := map[int64]string{}
	if len(parentNodeIDs) > 0 {
		folderNames, err = loadIDNameMap(ctx, q,
			`SELECT id, name FROM petrichor_kb_node WHERE user_id = $1 AND id = ANY($2)`,
			userID, parentNodeIDs)
		if err != nil {
			return nil, err
		}
	}
	for _, job := range jobs {
		entry := struct {
			kbName     *string
			folderName *string
			stats      importPageStats
		}{stats: emptyPageStats(job.TotalPages)}
		if name, ok := kbNames[job.KnowledgeBaseID]; ok {
			value := name
			entry.kbName = &value
		}
		if job.ParentNodeID != nil {
			if name, ok := folderNames[*job.ParentNodeID]; ok {
				value := name
				entry.folderName = &value
			}
		}
		pages, err := loadJobPages(ctx, job.ID)
		if err != nil {
			return nil, err
		}
		entry.stats = buildPageStats(pages)
		result[job.ID] = entry
	}
	return result, nil
}

func loadIDNameMap(ctx context.Context, q execQuerier, sql string, args ...any) (map[int64]string, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64]string{}
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		result[id] = name
	}
	return result, rows.Err()
}

func deriveJobStatus(pages []JobPageRow) string {
	if len(pages) == 0 {
		return "pending"
	}
	hasPending, hasFailed, hasDeadLetter := false, false, false
	for i := range pages {
		switch pages[i].Status {
		case "pending", "processing":
			hasPending = true
		case "failed":
			hasFailed = true
		case "dead_letter":
			hasDeadLetter = true
		}
	}
	if hasPending {
		return "processing"
	}
	if hasDeadLetter {
		return "dead_letter"
	}
	if hasFailed {
		return "failed"
	}
	// 页完成仅代表可成文，文章事务成功后才允许 completed。
	return "processing"
}

func countProcessedPages(pages []JobPageRow) int32 {
	count := int32(0)
	for i := range pages {
		if pages[i].Status == "done" || pages[i].Status == "failed" || pages[i].Status == "dead_letter" {
			count++
		}
	}
	return count
}

func refreshJobProgress(ctx context.Context, jobID int64) (int32, string, error) {
	pages, err := loadJobPages(ctx, jobID)
	if err != nil {
		return 0, "", err
	}
	processed := countProcessedPages(pages)
	status := deriveJobStatus(pages)
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return 0, "", err
	}
	_, err = store.UpdateJob(ctx, jobID, func(job *JobRow) error {
		if documentImportWorkerStopped(job) {
			return nil
		}
		job.ProcessedPages = processed
		// 终态由 Worker 以当前完整页快照收敛，单页进度不能抢先结束混合任务。
		return nil
	})
	return processed, status, err
}

func mergePageMarkdown(pages []JobPageRow) string {
	parts := make([]string, 0, len(pages))
	for i := range pages {
		text := trimSpace(derefStr(pages[i].Markdown))
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n\n")
}
