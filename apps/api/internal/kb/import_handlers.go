// import_handlers.go 提供以 Redis/Asynq 为唯一任务运行态的文档导入 HTTP 端点。
package kb

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

// CreateImportJob 在 Redis 登记导入任务；页面上传完成后由 Asynq Worker 领取。
func CreateImportJob(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, parentID, fileName, title, sourceKey, modelConfigID, err := parseCreateJobInput(raw)
		if err != nil {
			return nil, err
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
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		job, err := store.Create(c.Request.Context(), taskqueue.DocumentImportJob{
			UserID: user.ID, KnowledgeBaseID: kbID, ParentNodeID: parentID,
			FileName: fileName, SourceKey: &sourceKey, Title: title,
			Status: "processing", ModelConfigID: modelConfigID,
		})
		if err != nil {
			return nil, err
		}
		var folderName *string
		if parentFolder != nil {
			folderName = &parentFolder.Name
		}
		return map[string]any{
			"job":        toJobResponse(job, &kb.Name, folderName, nil),
			"ocrPageNos": []int64{},
			"isComplex":  false,
			"articleId":  nil,
		}, nil
	})
}

// AttachImportOcrPages 绑定 OCR 页整图并调度 Asynq。
func AttachImportOcrPages(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		jobID, incoming, err := parseAttachOcrPagesInput(raw)
		if err != nil {
			return nil, err
		}
		_ = resolveImportConcurrency(raw) // 真实并发统一由 Asynq Worker 配置控制。
		job, err := loadJobOwned(c.Request.Context(), user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "canceled" {
			return nil, badReq("任务已取消")
		}
		if job.ArticleID != nil {
			return nil, badReq("任务已完成，无法再补充页面图片")
		}
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		accepted := 0
		_, err = store.UpdatePages(c.Request.Context(), job.ID, func(pages []*JobPageRow) error {
			accepted = 0
			seen := map[int64]struct{}{}
			byPageNo := make(map[int64]*JobPageRow, len(pages))
			for _, page := range pages {
				if page.ExtractedBy == "vision" {
					byPageNo[int64(page.PageNo)] = page
				}
			}
			for _, candidate := range incoming {
				pageNo := candidate["pageNo"].(int64)
				if _, duplicate := seen[pageNo]; duplicate {
					continue
				}
				page := byPageNo[pageNo]
				if page == nil {
					continue
				}
				seen[pageNo] = struct{}{}
				imageKey := candidate["imageKey"].(string)
				page.ImageKey = &imageKey
				resetDocumentImportPage(page)
				accepted++
			}
			if accepted == 0 {
				return badReq("没有匹配的待识别页面")
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		if err := markDocumentImportRunnable(c.Request.Context(), job.ID, false); err != nil {
			return nil, err
		}
		if err := enqueueDocumentImport(c.Request.Context(), job.ID); err != nil {
			return nil, err
		}
		return map[string]any{"attached": accepted, "status": "processing"}, nil
	})
}

// FinalizeImportJob 全部页完成后幂等合并生成文章。
func FinalizeImportJob(c *gin.Context) {
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
		if err := finalizeImportJobToArticle(c.Request.Context(), job.ID); err != nil {
			return nil, err
		}
		updated, err := loadJobOwned(c.Request.Context(), user.ID, job.ID)
		if err != nil {
			return nil, err
		}
		if updated.ArticleID == nil {
			return nil, errors.New("导入任务未生成文章")
		}
		var nodeID int64
		if err := pool().QueryRow(c.Request.Context(),
			`SELECT node_id FROM petrichor_kb_article WHERE id = $1 AND user_id = $2`,
			*updated.ArticleID, user.ID).Scan(&nodeID); err != nil {
			return nil, err
		}
		return map[string]any{
			"articleId": strconv.FormatInt(*updated.ArticleID, 10),
			"nodeId":    strconv.FormatInt(nodeID, 10),
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
		updated, err := store.UpdateJob(c.Request.Context(), job.ID, func(current *JobRow) error {
			if current.ArticleID != nil || current.Status == "completed" {
				return badReq("任务已完成，无法取消")
			}
			current.Status = "canceled"
			return nil
		})
		if err != nil {
			return nil, err
		}
		_ = store.SetRunnable(c.Request.Context(), job.ID, false)
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
	if page.ExtractedBy != "vision" {
		return nil, badReq("该页由 PDF 本地抽取，无需模型识别")
	}
	if page.ImageKey == nil || derefStr(page.ImageKey) == "" {
		return nil, badReq("该页尚未上传整页图片")
	}
	if refreshModel {
		job, err = switchJobToDefaultVisionModel(c.Request.Context(), pool(), user.ID, job)
		if err != nil {
			return nil, err
		}
	}
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return nil, err
	}
	page, err = store.UpdatePage(c.Request.Context(), job.ID, pageNo, func(current *JobPageRow) error {
		resetDocumentImportPage(current)
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := markDocumentImportRunnable(c.Request.Context(), job.ID, refreshModel); err != nil {
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
		if _, err := switchJobToDefaultVisionModel(c.Request.Context(), pool(), user.ID, job); err != nil {
			return nil, err
		}
		store, err := taskqueue.DocumentImports()
		if err != nil {
			return nil, err
		}
		retried := 0
		_, err = store.UpdatePages(c.Request.Context(), job.ID, func(pages []*JobPageRow) error {
			retried = 0
			for _, page := range pages {
				if page.Status == "failed" || page.Status == "dead_letter" {
					resetDocumentImportPage(page)
					retried++
				}
			}
			if retried == 0 {
				return badReq("没有需要重试的失败页")
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		if err := markDocumentImportRunnable(c.Request.Context(), job.ID, true); err != nil {
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
			return nil, err
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
	now := time.Now().UTC()
	page.Status = "pending"
	page.Error = nil
	page.LastError = nil
	page.AttemptCount = 0
	page.NextAttemptAt = now
	page.DeadLetteredAt = nil
}

func markDocumentImportRunnable(ctx context.Context, jobID int64, replay bool) error {
	store, err := taskqueue.DocumentImports()
	if err != nil {
		return err
	}
	_, err = store.UpdateJob(ctx, jobID, func(job *JobRow) error {
		job.Status = "processing"
		job.Error = nil
		job.DeadLetteredAt = nil
		if replay {
			job.ReplayCount++
		}
		return nil
	})
	if err != nil {
		return err
	}
	return store.SetRunnable(ctx, jobID, true)
}

func enqueueDocumentImport(ctx context.Context, jobID int64) error {
	if err := taskqueue.EnqueueDocumentImport(ctx, jobID); err != nil {
		return &httpx.HttpError{Status: 503, Message: "视觉导入队列暂不可用；Redis 补偿任务会自动重试入队"}
	}
	return nil
}
