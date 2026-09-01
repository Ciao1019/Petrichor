// import_handlers.go 提供文档导入任务的 HTTP 端点。
package kb

import (
	"context"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/httpx"
)

// ===== 端点 =====

// CreateImportJob 登记导入任务；页面上传完成后由独立 Go Worker 从数据库领取。
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

		job, err := queryJob(c.Request.Context(), q,
			`INSERT INTO petrichor_kb_import_job (user_id, knowledge_base_id, parent_node_id,
			 source_type, file_name, source_key, title, total_pages, processed_pages, status, model_config_id)
			 VALUES ($1,$2,$3,'pdf',$4,$5,$6,0,0,'processing',$7) RETURNING `+jobColumns,
			user.ID, kbID, parentID, fileName, sourceKey, title, modelConfigID)
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

func queryJob(ctx context.Context, q execQuerier, sql string, args ...any) (*JobRow, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var r JobRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ParentNodeID, &r.SourceType,
		&r.FileName, &r.SourceKey, &r.Title, &r.TotalPages, &r.ProcessedPages, &r.Status,
		&r.ModelConfigID, &r.ArticleID, &r.Error, &r.LeaseOwner, &r.LeaseExpiresAt,
		&r.HeartbeatAt, &r.DeadLetteredAt, &r.ReplayCount, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// AttachImportOcrPages 绑定 OCR 页整图并调度后台处理。
func AttachImportOcrPages(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		jobID, pages, err := parseAttachOcrPagesInput(raw)
		if err != nil {
			return nil, err
		}
		concurrency := resolveImportConcurrency(raw)
		q := pool()
		job, err := loadJobOwned(c.Request.Context(), q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "canceled" {
			return nil, badReq("任务已取消")
		}
		if job.ArticleID != nil {
			return nil, badReq("任务已完成，无法再补充页面图片")
		}

		ocrPageNos := map[int64]struct{}{}
		ocrRows, err := q.Query(c.Request.Context(),
			`SELECT page_no FROM petrichor_kb_import_job_page WHERE job_id = $1 AND extracted_by = 'vision'`,
			job.ID)
		if err != nil {
			return nil, err
		}
		for ocrRows.Next() {
			var pageNo int64
			if err := ocrRows.Scan(&pageNo); err != nil {
				ocrRows.Close()
				return nil, err
			}
			ocrPageNos[pageNo] = struct{}{}
		}
		ocrRows.Close()
		if err := ocrRows.Err(); err != nil {
			return nil, err
		}

		seen := map[int64]struct{}{}
		accepted := make([]map[string]any, 0, len(pages))
		for _, page := range pages {
			pageNo := page["pageNo"].(int64)
			if _, dup := seen[pageNo]; dup {
				continue
			}
			if _, isOcr := ocrPageNos[pageNo]; !isOcr {
				continue
			}
			seen[pageNo] = struct{}{}
			accepted = append(accepted, page)
		}
		if len(accepted) == 0 {
			return nil, badReq("没有匹配的待识别页面")
		}

		for _, page := range accepted {
			imageKey := page["imageKey"].(string)
			if _, uerr := q.Exec(c.Request.Context(),
				`UPDATE petrichor_kb_import_job_page
				 SET image_key = $1, status = 'pending', error = NULL, last_error = NULL,
				     attempt_count = 0, next_attempt_at = now(), dead_lettered_at = NULL, updated_at = now()
				 WHERE job_id = $2 AND page_no = $3`, imageKey, job.ID, page["pageNo"].(int64)); uerr != nil {
				return nil, uerr
			}
		}

		_ = concurrency // 并发度由后台处理器自行决定；保留解析以对齐校验行为
		return map[string]any{"attached": len(accepted), "status": "processing"}, nil
	})
}

// FinalizeImportJob 全部页完成后合并生成文章。
func FinalizeImportJob(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		jobID, err := reqID(raw["jobId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		job, err := loadJobOwned(c.Request.Context(), q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		articleID, nodeID, err := finalizeJobToArticle(c, q, user.ID, job)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"articleId": strconv.FormatInt(articleID, 10),
			"nodeId":    nullableIDString(nodeID),
		}, nil
	})
}

// CancelImportJob 取消任务（已完成任务不可取消）。
func CancelImportJob(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		jobID, err := reqID(raw["jobId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		job, err := loadJobOwned(c.Request.Context(), q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "completed" || job.ArticleID != nil {
			return nil, badReq("任务已完成，无法取消")
		}
		if _, err := q.Exec(c.Request.Context(),
			`UPDATE petrichor_kb_import_job SET status = 'canceled', updated_at = now() WHERE id = $1`,
			job.ID); err != nil {
			return nil, err
		}
		return map[string]any{"id": strconv.FormatInt(job.ID, 10), "status": "canceled"}, nil
	})
}

// RetryImportPage 重试单页（先重置状态再同步转写）。
func RetryImportPage(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
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
		q := pool()
		job, err := loadJobOwned(c.Request.Context(), q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "canceled" {
			return nil, badReq("任务已取消")
		}
		target, err := loadJobPage(c.Request.Context(), q, job.ID, pageNo)
		if err != nil {
			return nil, err
		}
		if target.ExtractedBy != "vision" {
			return nil, badReq("该页由 PDF 本地抽取，无需重试")
		}
		if target.ImageKey == nil || derefStr(target.ImageKey) == "" {
			return nil, badReq("该页尚未上传整页图片")
		}
		job, err = switchJobToDefaultVisionModel(c.Request.Context(), q, user.ID, job)
		if err != nil {
			return nil, err
		}
		if _, err := q.Exec(c.Request.Context(),
			`UPDATE petrichor_kb_import_job_page
			 SET status = 'pending', error = NULL, last_error = NULL, attempt_count = 0,
			     next_attempt_at = now(), dead_lettered_at = NULL, updated_at = now()
			 WHERE job_id = $1 AND page_no = $2`, job.ID, pageNo); err != nil {
			return nil, err
		}
		page, processed, status, err := convertSinglePage(c, q, user.ID, job, pageNo)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"page":           toPageResponse(page),
			"processedPages": processed,
			"status":         status,
		}, nil
	})
}

// RetryImportJobFailedPages 重置全部失败页并交回后台处理。
func RetryImportJobFailedPages(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		jobID, err := reqID(raw["jobId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		job, err := loadJobOwned(c.Request.Context(), q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "canceled" {
			return nil, badReq("任务已取消")
		}
		var failedCount int32
		if err := q.QueryRow(c.Request.Context(),
			`SELECT COUNT(*) FROM petrichor_kb_import_job_page WHERE job_id = $1 AND status IN ('failed', 'dead_letter')`,
			job.ID).Scan(&failedCount); err != nil {
			return nil, err
		}
		if failedCount == 0 {
			return nil, badReq("没有需要重试的失败页")
		}
		if _, err := switchJobToDefaultVisionModel(c.Request.Context(), q, user.ID, job); err != nil {
			return nil, err
		}
		if _, err := q.Exec(c.Request.Context(),
			`UPDATE petrichor_kb_import_job_page
			 SET status = 'pending', error = NULL, last_error = NULL, attempt_count = 0,
			     next_attempt_at = now(), dead_lettered_at = NULL, updated_at = now()
			 WHERE job_id = $1 AND status IN ('failed', 'dead_letter')`, job.ID); err != nil {
			return nil, err
		}
		if _, err := q.Exec(c.Request.Context(),
			`UPDATE petrichor_kb_import_job
			 SET status = 'processing', error = NULL, dead_lettered_at = NULL,
			     processed_pages = (SELECT COUNT(*)::integer FROM petrichor_kb_import_job_page
			                        WHERE job_id = $1 AND status = 'done'),
			     lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
			     replay_count = replay_count + 1, updated_at = now()
			 WHERE id = $1`, job.ID); err != nil {
			return nil, err
		}
		return map[string]any{"retried": failedCount, "status": "processing"}, nil
	})
}

// ConvertImportPage 手动转写单页。
func ConvertImportPage(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
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
		q := pool()
		job, err := loadJobOwned(c.Request.Context(), q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "canceled" {
			return nil, badReq("任务已取消")
		}
		page, processed, status, err := convertSinglePage(c, q, user.ID, job, pageNo)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"page":           toPageResponse(page),
			"processedPages": processed,
			"status":         status,
		}, nil
	})
}

// DeleteImportJobs 批量删除任务及其页面（已生成文章保持不变）。
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
			id, perr := reqID(item, "ID 必须是正整数")
			if perr != nil {
				return nil, perr
			}
			idSet[id] = struct{}{}
		}
		uniqueIDs := setToSortedSlice(idSet)
		q := pool()
		rows, err := q.Query(c.Request.Context(),
			`SELECT id FROM petrichor_kb_import_job WHERE user_id = $1 AND id = ANY($2)`,
			user.ID, uniqueIDs)
		if err != nil {
			return nil, err
		}
		var ownedIDs []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			ownedIDs = append(ownedIDs, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(ownedIDs) == 0 {
			return map[string]any{"deleted": []string{}}, nil
		}
		if _, err := q.Exec(c.Request.Context(),
			`DELETE FROM petrichor_kb_import_job_page WHERE job_id = ANY($1)`, ownedIDs); err != nil {
			return nil, err
		}
		if _, err := q.Exec(c.Request.Context(),
			`DELETE FROM petrichor_kb_import_job WHERE id = ANY($1)`, ownedIDs); err != nil {
			return nil, err
		}
		deleted := make([]string, 0, len(ownedIDs))
		for _, id := range ownedIDs {
			deleted = append(deleted, strconv.FormatInt(id, 10))
		}
		return map[string]any{"deleted": deleted}, nil
	})
}

// ListImportJobs 分页列表（带装饰信息）。
func ListImportJobs(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		var pagination httpx.PaginationInput
		if v, ok := raw["pageNum"].(float64); ok && v > 0 {
			pn := int64(v)
			pagination.PageNum = &pn
		}
		if v, ok := raw["pageSize"].(float64); ok && v > 0 {
			ps := int64(v)
			pagination.PageSize = &ps
		}
		kbFilter := parseOptionalID(raw, "knowledgeBaseId")

		sql := `SELECT ` + jobColumns + ` FROM petrichor_kb_import_job WHERE user_id = $1`
		args := []any{user.ID}
		if kbFilter != nil {
			sql += ` AND knowledge_base_id = $2`
			args = append(args, *kbFilter)
		}
		p := httpx.ResolvePagination(pagination)

		q := pool()
		countSQL := strings.Replace(sql, "SELECT "+jobColumns, "SELECT COUNT(*)", 1)
		var total int64
		if err := q.QueryRow(c.Request.Context(), countSQL, args...).Scan(&total); err != nil {
			return nil, err
		}
		listSQL := sql + ` ORDER BY created_at DESC, id DESC LIMIT $` +
			strconv.Itoa(len(args)+1) + ` OFFSET $` + strconv.Itoa(len(args)+2)
		args = append(args, p.Limit, p.Offset)
		jobs, err := queryJobs(c.Request.Context(), q, listSQL, args...)
		if err != nil {
			return nil, err
		}
		pointers := make([]*JobRow, 0, len(jobs))
		for i := range jobs {
			pointers = append(pointers, &jobs[i])
		}
		extras, err := loadJobDecorations(c.Request.Context(), q, user.ID, pointers)
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

func queryJobs(ctx context.Context, q execQuerier, sql string, args ...any) ([]JobRow, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JobRow
	for rows.Next() {
		var r JobRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ParentNodeID, &r.SourceType,
			&r.FileName, &r.SourceKey, &r.Title, &r.TotalPages, &r.ProcessedPages, &r.Status,
			&r.ModelConfigID, &r.ArticleID, &r.Error, &r.LeaseOwner, &r.LeaseExpiresAt,
			&r.HeartbeatAt, &r.DeadLetteredAt, &r.ReplayCount, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DetailImportJob 任务详情（含全部页）。
func DetailImportJob(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		jobID, err := reqID(raw["jobId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		job, err := loadJobOwned(c.Request.Context(), q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		pages, err := loadJobPages(c.Request.Context(), q, job.ID)
		if err != nil {
			return nil, err
		}
		extras, err := loadJobDecorations(c.Request.Context(), q, user.ID, []*JobRow{job})
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
