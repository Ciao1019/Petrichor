// import_handlers.go 提供以 Redis/Asynq 为唯一任务运行态的文档导入 HTTP 端点。
package kb

import (
	"context"
	"strconv"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

// CreateImportJob 只接受原件元数据；零页 preparing 任务立即交给服务端 Worker。
func CreateImportJob(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		idempotencyKey, err := parseImportCreateOptions(raw)
		if err != nil {
			return nil, err
		}
		imagePolicy, err := parseImportImagePolicy(raw)
		if err != nil {
			return nil, err
		}
		kbID, parentID, fileName, title, sourceKey, modelConfigID, err := parseCreateJobInput(raw)
		if err != nil {
			return nil, err
		}
		if err := validateImportObjectKey(user.ID, sourceKey); err != nil {
			return nil, err
		}
		sourceKey = storage.StripS4KeyPrefix(sourceKey)
		sourceType, err := importSourceType(fileName)
		if err != nil {
			return nil, err
		}
		input := taskqueue.DocumentImportJob{
			UserID: user.ID, KnowledgeBaseID: kbID, ParentNodeID: parentID,
			FileName: fileName, SourceKey: &sourceKey, Title: title, SourceType: sourceType,
			Status: "processing", Stage: "preparing", ModelConfigID: modelConfigID,
			Concurrency: resolveImportConcurrency(raw), IdempotencyKey: idempotencyKey, ImagePolicy: imagePolicy,
		}
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		job, err := store.FindIdempotent(c.Request.Context(), input)
		if err != nil {
			return nil, importMutationError(err)
		}
		if job != nil {
			return importCreateResponse(c.Request.Context(), store, job, nil, nil)
		}
		q := pool()
		kb, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		parentFolder, err := assertFolderParent(c.Request.Context(), q, user.ID, kbID, parentID)
		if err != nil {
			return nil, err
		}
		job, err = store.Create(c.Request.Context(), input)
		if err != nil {
			return nil, importMutationError(err)
		}
		var folderName *string
		if parentFolder != nil {
			folderName = &parentFolder.Name
		}
		return importCreateResponse(c.Request.Context(), store, job, &kb.Name, folderName)
	})
}

func importCreateResponse(ctx context.Context, store *taskqueue.DocumentImportStore, job *JobRow, kbName, folderName *string) (any, error) {
	// 创建/幂等命中均补入队；入队失败不丢任务，持久化 runnable 由 reconcile 恢复。
	_ = enqueueDocumentImport(ctx, job.ID)
	pages, err := store.Pages(ctx, job.ID)
	if err != nil {
		return nil, err
	}
	stats := buildPageStats(pages)
	return map[string]any{"job": toJobResponse(job, kbName, folderName, &stats), "articleId": nil}, nil
}

// FinalizeImportJob 只恢复成文调度；文章始终由 Worker 幂等生成。
func FinalizeImportJob(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		jobID, err := requestImportJobID(c)
		if err != nil {
			return nil, err
		}
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		job, pages, err := requestImportFinalization(c.Request.Context(), store, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if !documentImportJobTerminal(job) {
			// 释放成文锁后补入队；失败仍保留原子写入的 runnable，由 reconcile 补偿。
			_ = enqueueDocumentImport(c.Request.Context(), job.ID)
		}
		stats := buildPageStats(pages)
		return map[string]any{
			"job":       toJobResponse(job, nil, nil, &stats),
			"articleId": nullableIDString(job.ArticleID),
		}, nil
	})
}

func CancelImportJob(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		jobID, err := requestImportJobID(c)
		if err != nil {
			return nil, err
		}
		job, err := loadJobOwned(c.Request.Context(), user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "completed" || job.ArticleID != nil {
			return nil, badReq("任务已完成，无法取消")
		}
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		updated, err := store.CancelOwned(c.Request.Context(), user.ID, job.ID)
		if err != nil {
			return nil, importMutationError(err)
		}
		_ = taskqueue.RemoveDocumentImportTask(job.ID)
		return map[string]any{"id": strconv.FormatInt(updated.ID, 10), "status": updated.Status}, nil
	})
}

// RetryImportPage 仅重置 Redis 页状态并重新入队，不再在 API 进程同步调用模型。
func RetryImportPage(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		return retryOneImportPage(c, true)
	})
}

// ConvertImportPage 同样通过 Asynq 调度，保证所有视觉模型调用都受统一并发控制。
func ConvertImportPage(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		return retryOneImportPage(c, false)
	})
}

func retryOneImportPage(c *gin.Context, refreshModel bool) (any, error) {
	user := currentUser(c)
	raw, err := readBody(c)
	if err != nil {
		return nil, err
	}
	jobID, err := reqID(raw["jobId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	pageNo, err := parsePositiveInt(raw["pageNo"])
	if err != nil {
		return nil, badReq("pageNo 必须是正整数")
	}
	job, err := loadJobOwned(c.Request.Context(), user.ID, jobID)
	if err != nil {
		return nil, err
	}
	if job.Status == "canceled" {
		return nil, badReq("任务已取消")
	}
	page, err := loadJobPage(c.Request.Context(), job.ID, pageNo)
	if err != nil {
		return nil, err
	}
	if page.Status == "done" || job.ArticleID != nil {
		return map[string]any{"page": toPageResponse(page), "processedPages": job.ProcessedPages, "status": job.Status}, nil
	}
	if page.ExtractedBy == "direct" {
		return nil, badReq("该页已直接解析，无需 OCR")
	}
	if page.ImageKey == nil || derefStr(page.ImageKey) == "" {
		return nil, badReq("该页尚未上传整页图片")
	}
	// 模型仅在需要识别图片时解析，不影响 anydoc 直接提取正文。
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return nil, err
	}
	_, err = mutateImportRetry(c.Request.Context(), store, job.ID, refreshModel, func(pages []*JobPageRow) error {
		for _, current := range pages {
			if int64(current.PageNo) == pageNo {
				if current.Status != "done" && (current.ExtractedBy == "direct" || derefStr(current.ImageKey) == "") {
					return badReq("该页无需 OCR 或尚未上传图片")
				}
				resetDocumentImportPage(current)
				page = current
				return nil
			}
		}
		return notFoundErr("导入任务页不存在")
	})
	if err != nil {
		return nil, err
	}
	if err := enqueueDocumentImport(c.Request.Context(), job.ID); err != nil {
		return nil, err
	}
	updated, err := store.Get(c.Request.Context(), job.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"page":           toPageResponse(page),
		"processedPages": updated.ProcessedPages,
		"status":         updated.Status,
	}, nil
}

func RetryImportJobFailedPages(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		jobID, err := requestImportJobID(c)
		if err != nil {
			return nil, err
		}
		job, err := loadJobOwned(c.Request.Context(), user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "canceled" {
			return nil, badReq("任务已取消")
		}
		if job.ArticleID != nil {
			return map[string]any{"retried": 0, "status": "completed"}, nil
		}
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		retried, err := retryFailedImportJob(c.Request.Context(), store, job.ID)
		if err != nil {
			return nil, err
		}
		if err := enqueueDocumentImport(c.Request.Context(), job.ID); err != nil {
			return nil, err
		}
		return map[string]any{"retried": retried, "status": "processing"}, nil
	})
}

func DeleteImportJobs(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		list, _ := raw["ids"].([]any)
		if len(list) < 1 || len(list) > 200 {
			return nil, badReq("ids 数量必须在 1 到 200 之间")
		}
		idSet := map[int64]struct{}{}
		for _, item := range list {
			id, err := reqID(item, "ID 必须是正整数")
			if err != nil {
				return nil, err
			}
			idSet[id] = struct{}{}
		}
		ids := setToSortedSlice(idSet)
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		deletedIDs, err := store.DeleteOwned(c.Request.Context(), user.ID, ids)
		if err != nil {
			return nil, importMutationError(err)
		}
		deleted := make([]string, 0, len(deletedIDs))
		for _, id := range deletedIDs {
			_ = taskqueue.RemoveDocumentImportTask(id)
			deleted = append(deleted, strconv.FormatInt(id, 10))
		}
		return map[string]any{"deleted": deleted}, nil
	})
}

func ListImportJobs(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		var pagination httpx.PaginationInput
		if value, ok := raw["pageNum"].(float64); ok && value > 0 {
			pageNum := int64(value)
			pagination.PageNum = &pageNum
		}
		if value, ok := raw["pageSize"].(float64); ok && value > 0 {
			pageSize := int64(value)
			pagination.PageSize = &pageSize
		}
		filter := parseOptionalID(raw, "knowledgeBaseId")
		resolved := httpx.ResolvePagination(pagination)
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		jobs, total, err := store.List(c.Request.Context(), user.ID, filter, resolved.Offset, resolved.Limit)
		if err != nil {
			return nil, err
		}
		pointers := make([]*JobRow, 0, len(jobs))
		for i := range jobs {
			pointers = append(pointers, &jobs[i])
		}
		extras, err := loadJobDecorations(c.Request.Context(), pool(), user.ID, pointers)
		if err != nil {
			return nil, err
		}
		items := make([]map[string]any, 0, len(jobs))
		for i := range jobs {
			extra := extras[jobs[i].ID]
			items = append(items, toJobResponse(&jobs[i], extra.kbName, extra.folderName, &extra.stats))
		}
		httpx.TableData(c, items, total)
		return nil, nil
	})
}

func DetailImportJob(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		jobID, err := requestImportJobID(c)
		if err != nil {
			return nil, err
		}
		job, err := loadJobOwned(c.Request.Context(), user.ID, jobID)
		if err != nil {
			return nil, err
		}
		pages, err := loadJobPages(c.Request.Context(), job.ID)
		if err != nil {
			return nil, err
		}
		extras, err := loadJobDecorations(c.Request.Context(), pool(), user.ID, []*JobRow{job})
		if err != nil {
			return nil, err
		}
		extra := extras[job.ID]
		pageMaps := make([]map[string]any, 0, len(pages))
		for i := range pages {
			pageMaps = append(pageMaps, toPageResponse(&pages[i]))
		}
		return map[string]any{
			"job":   toJobResponse(job, extra.kbName, extra.folderName, &extra.stats),
			"pages": pageMaps,
		}, nil
	})
}

func requestImportJobID(c *gin.Context) (int64, error) {
	raw, err := readBody(c)
	if err != nil {
		return 0, err
	}
	return reqID(raw["jobId"], "ID 必须是正整数")
}

func resetDocumentImportPage(page *JobPageRow) {
	taskqueue.ResetDocumentImportPageRetry(page)
}

func enqueueDocumentImport(ctx context.Context, jobID int64) error {
	pages, err := loadJobPages(ctx, jobID)
	if err != nil {
		return err
	}
	job, err := loadJobByID(ctx, jobID)
	if err != nil {
		return err
	}
	if !taskqueue.DocumentImportRunnable(job, pages) {
		return nil
	}
	if err := taskqueue.EnqueueDocumentImport(ctx, jobID); err != nil {
		return &httpx.HttpError{Status: 503, Message: "视觉导入队列暂不可用；Redis 补偿任务会自动重试入队"}
	}
	return nil
}
