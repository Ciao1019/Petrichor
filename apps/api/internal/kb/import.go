// import.go 对照 import-handlers.ts：导入任务登记类逻辑完整移植；
// PDF 本地抽取与多模态 OCR 循环通过注入变量接入（StartImportJob / VisionPageConverter）。
package kb

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	httpx "petrichor/api/internal/httpx"
)

const (
	defaultImportConcurrency = 4
	maxImportConcurrency     = 8
)

// VisionPageConverter 单页多模态识别钩子（对应 convertSinglePage 内的
// fetchS3ObjectBytes + callVisionCompletion）。nil 时相关端点返回 503「AI 服务未就绪」；
// 返回错误时页面标记 failed 并写入截断后的错误信息。
var VisionPageConverter func(ctx context.Context, userID, jobID, pageNo int64) (string, error)

// ===== 输入解析 =====

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
	title, err2 := parseTitleField(raw, 200)
	if err2 != nil {
		err = err2
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

func parseAttachOcrPagesInput(raw map[string]any) (jobID int64, pages []map[string]any, err error) {
	jobID, err = reqID(raw["jobId"], "ID 必须是正整数")
	if err != nil {
		return
	}
	list, _ := raw["pages"].([]any)
	if len(list) < 1 || len(list) > 2000 {
		err = badReq("pages 数量必须在 1 到 2000 之间")
		return
	}
	for _, item := range list {
		pageRaw, ok := item.(map[string]any)
		if !ok {
			err = badReq("请求参数错误")
			return
		}
		pageNo, perr := parsePositiveInt(pageRaw["pageNo"])
		if perr != nil {
			err = badReq("pageNo 必须是正整数")
			return
		}
		imageKey := trimmedString(pageRaw, "imageKey")
		if imageKey == "" {
			err = badReq("imageKey 不能为空")
			return
		}
		pages = append(pages, map[string]any{"pageNo": pageNo, "imageKey": imageKey})
	}
	return
}

func parsePositiveInt(raw any) (int64, error) {
	switch v := raw.(type) {
	case string:
		n, err := strconv.ParseInt(trimSpace(v), 10, 64)
		if err != nil || n <= 0 {
			return 0, badReq("必须是正整数")
		}
		return n, nil
	case float64:
		n := int64(v)
		if v <= 0 || float64(n) != v {
			return 0, badReq("必须是正整数")
		}
		return n, nil
	default:
		return 0, badReq("必须是正整数")
	}
}

func resolveImportConcurrency(raw map[string]any) int32 {
	v, ok := raw["concurrency"].(float64)
	if !ok || v <= 0 {
		return defaultImportConcurrency
	}
	value := int(v)
	if value > maxImportConcurrency {
		value = maxImportConcurrency
	}
	if value < 1 {
		value = 1
	}
	return int32(value)
}

// ===== 行加载 =====

func loadJobOwned(q execQuerier, userID, jobID int64) (*JobRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+jobColumns+` FROM petrichor_kb_import_job WHERE id = $1 AND user_id = $2 LIMIT 1`,
		jobID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, notFoundErr("导入任务不存在")
	}
	var r JobRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ParentNodeID, &r.SourceType,
		&r.FileName, &r.SourceKey, &r.Title, &r.TotalPages, &r.ProcessedPages, &r.Status,
		&r.ModelConfigID, &r.ArticleID, &r.Error, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

func loadJobPages(q execQuerier, jobID int64) ([]JobPageRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+jobPageColumns+` FROM petrichor_kb_import_job_page WHERE job_id = $1 ORDER BY page_no ASC`,
		jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JobPageRow
	for rows.Next() {
		var r JobPageRow
		if err := rows.Scan(&r.ID, &r.JobID, &r.PageNo, &r.ImageKey, &r.ExtractedBy, &r.Status,
			&r.Markdown, &r.Error, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ===== 响应组装 =====

type importPageStats struct {
	donePages    int32
	failedPages  int32
	pendingPages int32
}

func emptyPageStats(totalPages int32) importPageStats {
	return importPageStats{pendingPages: totalPages}
}

func buildPageStats(pages []JobPageRow) importPageStats {
	stats := importPageStats{}
	for i := range pages {
		switch pages[i].Status {
		case "done":
			stats.donePages++
		case "failed":
			stats.failedPages++
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
	return map[string]any{
		"id":                strconv.FormatInt(job.ID, 10),
		"knowledgeBaseId":   strconv.FormatInt(job.KnowledgeBaseID, 10),
		"knowledgeBaseName": extraKBName,
		"parentNodeId":      nullableIDString(job.ParentNodeID),
		"parentFolderName":  extraFolderName,
		"sourceType":        job.SourceType,
		"fileName":          job.FileName,
		"title":             job.Title,
		"totalPages":        job.TotalPages,
		"processedPages":    job.ProcessedPages,
		"donePages":         pageStats.donePages,
		"failedPages":       pageStats.failedPages,
		"pendingPages":      pageStats.pendingPages,
		"status":            job.Status,
		"modelConfigId":     nullableIDString(job.ModelConfigID),
		"articleId":         nullableIDString(job.ArticleID),
		"error":             job.Error,
		"createdAt":         iso(job.CreatedAt),
		"updatedAt":         iso(job.UpdatedAt),
	}
}

func toPageResponse(page *JobPageRow) map[string]any {
	return map[string]any{
		"pageNo":      page.PageNo,
		"imageKey":    page.ImageKey,
		"extractedBy": page.ExtractedBy,
		"status":      page.Status,
		"markdown":    page.Markdown,
		"error":       page.Error,
	}
}

// loadJobDecorations 对应同名函数：批量补齐知识库名、父文件夹名与页级统计。
func loadJobDecorations(q execQuerier, userID int64, jobs []*JobRow) (map[int64]struct {
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
	jobIDs := make([]int64, 0, len(jobs))
	for _, job := range jobs {
		jobIDs = append(jobIDs, job.ID)
	}

	type statAcc struct {
		done, failed, pending int32
	}
	statsByJob := map[int64]*statAcc{}
	rows, err := q.Query(context.Background(),
		`SELECT job_id, status FROM petrichor_kb_import_job_page WHERE job_id = ANY($1)`, jobIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var jobID int64
		var status string
		if err := rows.Scan(&jobID, &status); err != nil {
			rows.Close()
			return nil, err
		}
		acc, ok := statsByJob[jobID]
		if !ok {
			acc = &statAcc{}
			statsByJob[jobID] = acc
		}
		switch status {
		case "done":
			acc.done++
		case "failed":
			acc.failed++
		default:
			acc.pending++
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	kbIDs := map[int64]struct{}{}
	for _, job := range jobs {
		kbIDs[job.KnowledgeBaseID] = struct{}{}
	}
	kbNames, err := loadIDNameMap(q,
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
		folderNames, err = loadIDNameMap(q,
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
			s := name
			entry.kbName = &s
		}
		if job.ParentNodeID != nil {
			if name, ok := folderNames[*job.ParentNodeID]; ok {
				s := name
				entry.folderName = &s
			}
		}
		if acc, ok := statsByJob[job.ID]; ok {
			entry.stats = importPageStats{donePages: acc.done, failedPages: acc.failed, pendingPages: acc.pending}
		}
		result[job.ID] = entry
	}
	return result, nil
}

func loadIDNameMap(q execQuerier, sql string, args ...any) (map[int64]string, error) {
	rows, err := q.Query(context.Background(), sql, args...)
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

// ===== 进度推导（对应 import-logic.ts） =====

// deriveJobStatus 有 pending → processing；无 pending 有 failed → failed；全 done → completed。
func deriveJobStatus(pages []JobPageRow) string {
	if len(pages) == 0 {
		return "pending"
	}
	hasPending, hasFailed := false, false
	for i := range pages {
		switch pages[i].Status {
		case "pending":
			hasPending = true
		case "failed":
			hasFailed = true
		}
	}
	if hasPending {
		return "processing"
	}
	if hasFailed {
		return "failed"
	}
	return "completed"
}

func countProcessedPages(pages []JobPageRow) int32 {
	count := int32(0)
	for i := range pages {
		if pages[i].Status != "pending" {
			count++
		}
	}
	return count
}

func refreshJobProgress(q execQuerier, jobID int64) (int32, string, error) {
	pages, err := loadJobPages(q, jobID)
	if err != nil {
		return 0, "", err
	}
	processed := countProcessedPages(pages)
	status := deriveJobStatus(pages)
	if _, err := q.Exec(context.Background(),
		`UPDATE petrichor_kb_import_job SET processed_pages = $1, status = $2, updated_at = now() WHERE id = $3`,
		processed, status, jobID); err != nil {
		return 0, "", err
	}
	return processed, status, nil
}

// mergePageMarkdown 按页码顺序合并非空 Markdown，页间以空行分隔。
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

// ===== 核心流程 =====

// finalizeJobToArticle 校验任务可合并后创建节点与文章（对应同名函数）。
func finalizeJobToArticle(c *gin.Context, q execQuerier, userID int64, job *JobRow) (int64, *int64, error) {
	if job.Status == "canceled" {
		return 0, nil, badReq("任务已取消")
	}
	if job.ArticleID != nil {
		return *job.ArticleID, nil, nil
	}
	pages, err := loadJobPages(q, job.ID)
	if err != nil {
		return 0, nil, err
	}
	if len(pages) == 0 {
		return 0, nil, badReq("任务没有可合并的页面")
	}
	notDone := 0
	for i := range pages {
		if pages[i].Status != "done" {
			notDone++
		}
	}
	if notDone > 0 {
		return 0, nil, badReq("仍有 " + strconv.Itoa(notDone) + " 页未成功转换，请先重试失败页")
	}

	if _, err := assertKnowledgeBaseOwner(q, userID, job.KnowledgeBaseID); err != nil {
		return 0, nil, err
	}
	if _, err := assertFolderParent(q, userID, job.KnowledgeBaseID, job.ParentNodeID); err != nil {
		return 0, nil, err
	}

	contentMd := mergePageMarkdown(pages)
	sortOrder, err := nextSortOrder(q, userID, job.KnowledgeBaseID, job.ParentNodeID)
	if err != nil {
		return 0, nil, err
	}
	var nodeID int64
	if err := q.QueryRow(c,
		`INSERT INTO petrichor_kb_node (user_id, knowledge_base_id, parent_id, type, name, sort_order)
		 VALUES ($1,$2,$3,'ARTICLE',$4,$5) RETURNING id`,
		userID, job.KnowledgeBaseID, job.ParentNodeID, job.Title, sortOrder).Scan(&nodeID); err != nil {
		return 0, nil, err
	}
	publicExcerpt, readingMinutes, tocJSON, contentHash := buildPublicArticleMetadata(contentMd)
	var articleID int64
	if err := q.QueryRow(c,
		`INSERT INTO petrichor_kb_article (user_id, knowledge_base_id, node_id, title, content_md,
		 public_excerpt, reading_minutes, toc_json, public_content_hash)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
		userID, job.KnowledgeBaseID, nodeID, job.Title, contentMd,
		publicExcerpt, readingMinutes, tocJSON, contentHash).Scan(&articleID); err != nil {
		return 0, nil, err
	}
	if _, err := q.Exec(c,
		`UPDATE petrichor_kb_import_job SET article_id = $1, status = 'completed', error = NULL, updated_at = now()
		 WHERE id = $2`, articleID, job.ID); err != nil {
		return 0, nil, err
	}
	return articleID, &nodeID, nil
}

// switchJobToDefaultVisionModel 手动重试改用当前默认多模态模型（对应同名函数的 DB 部分）。
func switchJobToDefaultVisionModel(q execQuerier, userID int64, job *JobRow) (*JobRow, error) {
	resolved, err := resolveVisionModelRefID(q, userID, job.ModelConfigID)
	if err != nil {
		return nil, err
	}
	current := job.ModelConfigID
	if resolved != nil && current != nil && *resolved == *current {
		return job, nil
	}
	if _, err := q.Exec(context.Background(),
		`UPDATE petrichor_kb_import_job SET model_config_id = $1, updated_at = now() WHERE id = $2`,
		resolved, job.ID); err != nil {
		return nil, err
	}
	updated := *job
	updated.ModelConfigID = resolved
	return &updated, nil
}

// resolveVisionModelRefID 对应 resolveModelForPurpose(userId,"VISION",pinned)：
// 固定模型仍有效则用之，否则取用途绑定，均不可用报 400。
func resolveVisionModelRefID(q execQuerier, userID int64, pinned *int64) (*int64, error) {
	ctx := context.Background()
	if pinned != nil {
		var kind string
		var enabled bool
		err := q.QueryRow(ctx,
			`SELECT m.kind, m.enabled FROM petrichor_ai_model m
			 JOIN petrichor_ai_provider p ON p.id = m.provider_id
			 WHERE m.id = $1 AND m.user_id = $2 AND p.enabled = true LIMIT 1`, *pinned, userID).
			Scan(&kind, &enabled)
		if err == nil && enabled && kind == "VISION" {
			return pinned, nil
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
	}
	var modelRefID int64
	err := q.QueryRow(ctx,
		`SELECT model_ref_id FROM petrichor_ai_binding WHERE user_id = $1 AND purpose = 'VISION' LIMIT 1`,
		userID).Scan(&modelRefID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, badReq("未配置多模态模型，请前往「模型配置 → 用途绑定」为多模态选择一个模型")
		}
		return nil, err
	}
	id := modelRefID
	return &id, nil
}

// convertSinglePage 同步转写单页；转换器未注入时 503。
func convertSinglePage(c *gin.Context, q execQuerier, userID int64, job *JobRow, pageNo int64) (*JobPageRow, int32, string, error) {
	if VisionPageConverter == nil {
		return nil, 0, "", &httpx.HttpError{Status: 503, Message: "AI 服务未就绪"}
	}
	page, err := loadJobPage(q, job.ID, pageNo)
	if err != nil {
		return nil, 0, "", err
	}
	if page.ExtractedBy != "vision" {
		return nil, 0, "", badReq("该页由 PDF 本地抽取，无需模型识别")
	}
	if page.ImageKey == nil || derefStr(page.ImageKey) == "" {
		return nil, 0, "", badReq("该页尚未上传整页图片")
	}

	markdown, convErr := VisionPageConverter(c, userID, job.ID, pageNo)
	if convErr != nil {
		message := convErr.Error()
		runes := []rune(message)
		if len(runes) > 500 {
			message = string(runes[:500])
		}
		if _, uerr := q.Exec(c,
			`UPDATE petrichor_kb_import_job_page SET status = 'failed', error = $1, updated_at = now()
			 WHERE id = $2`, message, page.ID); uerr != nil {
			return nil, 0, "", uerr
		}
	} else {
		if _, uerr := q.Exec(c,
			`UPDATE petrichor_kb_import_job_page SET status = 'done', markdown = $1, error = NULL, updated_at = now()
			 WHERE id = $2`, markdown, page.ID); uerr != nil {
			return nil, 0, "", uerr
		}
	}

	processed, status, err := refreshJobProgress(q, job.ID)
	if err != nil {
		return nil, 0, "", err
	}
	updatedPage, err := loadJobPage(q, job.ID, pageNo)
	if err != nil {
		return nil, 0, "", err
	}
	return updatedPage, processed, status, nil
}

func loadJobPage(q execQuerier, jobID, pageNo int64) (*JobPageRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+jobPageColumns+` FROM petrichor_kb_import_job_page
		 WHERE job_id = $1 AND page_no = $2 LIMIT 1`, jobID, pageNo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, notFoundErr("导入任务页不存在")
	}
	var r JobPageRow
	if err := rows.Scan(&r.ID, &r.JobID, &r.PageNo, &r.ImageKey, &r.ExtractedBy, &r.Status,
		&r.Markdown, &r.Error, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// ===== 端点 =====

// CreateImportJob 登记导入任务。
// 偏差：TS 版在服务端同步做 PDF 本地逐页抽取；Go 版抽取整体交给 StartImportJob 钩子
// （含页面行落库），本端点只负责任务登记与归属校验。
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
		kb, err := assertKnowledgeBaseOwner(q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		parentFolder, err := assertFolderParent(q, user.ID, kbID, parentID)
		if err != nil {
			return nil, err
		}

		job, err := queryJob(q,
			`INSERT INTO petrichor_kb_import_job (user_id, knowledge_base_id, parent_node_id,
			 source_type, file_name, source_key, title, total_pages, processed_pages, status, model_config_id)
			 VALUES ($1,$2,$3,'pdf',$4,$5,$6,0,0,'processing',$7) RETURNING `+jobColumns,
			user.ID, kbID, parentID, fileName, sourceKey, title, modelConfigID)
		if err != nil {
			return nil, err
		}

		if StartImportJob != nil {
			StartImportJob(c, job.ID)
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

func queryJob(q execQuerier, sql string, args ...any) (*JobRow, error) {
	rows, err := q.Query(context.Background(), sql, args...)
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
		&r.ModelConfigID, &r.ArticleID, &r.Error, &r.CreatedAt, &r.UpdatedAt); err != nil {
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
		job, err := loadJobOwned(q, user.ID, jobID)
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
		ocrRows, err := q.Query(c,
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
			if _, uerr := q.Exec(c,
				`UPDATE petrichor_kb_import_job_page SET image_key = $1, status = 'pending', error = NULL, updated_at = now()
				 WHERE job_id = $2 AND page_no = $3`, imageKey, job.ID, page["pageNo"].(int64)); uerr != nil {
				return nil, uerr
			}
		}

		if StartImportJob != nil {
			StartImportJob(c, job.ID)
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
		job, err := loadJobOwned(q, user.ID, jobID)
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
		job, err := loadJobOwned(q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "completed" || job.ArticleID != nil {
			return nil, badReq("任务已完成，无法取消")
		}
		if _, err := q.Exec(c,
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
		job, err := loadJobOwned(q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "canceled" {
			return nil, badReq("任务已取消")
		}
		target, err := loadJobPage(q, job.ID, pageNo)
		if err != nil {
			return nil, err
		}
		if target.ExtractedBy != "vision" {
			return nil, badReq("该页由 PDF 本地抽取，无需重试")
		}
		if target.ImageKey == nil || derefStr(target.ImageKey) == "" {
			return nil, badReq("该页尚未上传整页图片")
		}
		job, err = switchJobToDefaultVisionModel(q, user.ID, job)
		if err != nil {
			return nil, err
		}
		if _, err := q.Exec(c,
			`UPDATE petrichor_kb_import_job_page SET status = 'pending', error = NULL, updated_at = now()
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
		job, err := loadJobOwned(q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		if job.Status == "canceled" {
			return nil, badReq("任务已取消")
		}
		var failedCount int32
		if err := q.QueryRow(c,
			`SELECT COUNT(*) FROM petrichor_kb_import_job_page WHERE job_id = $1 AND status = 'failed'`,
			job.ID).Scan(&failedCount); err != nil {
			return nil, err
		}
		if failedCount == 0 {
			return nil, badReq("没有需要重试的失败页")
		}
		if _, err := switchJobToDefaultVisionModel(q, user.ID, job); err != nil {
			return nil, err
		}
		if _, err := q.Exec(c,
			`UPDATE petrichor_kb_import_job_page SET status = 'pending', error = NULL, updated_at = now()
			 WHERE job_id = $1 AND status = 'failed'`, job.ID); err != nil {
			return nil, err
		}
		if _, err := q.Exec(c,
			`UPDATE petrichor_kb_import_job SET status = 'processing', error = NULL, updated_at = now()
			 WHERE id = $1`, job.ID); err != nil {
			return nil, err
		}
		if StartImportJob != nil {
			StartImportJob(c, job.ID)
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
		job, err := loadJobOwned(q, user.ID, jobID)
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
		rows, err := q.Query(c,
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
		if _, err := q.Exec(c,
			`DELETE FROM petrichor_kb_import_job_page WHERE job_id = ANY($1)`, ownedIDs); err != nil {
			return nil, err
		}
		if _, err := q.Exec(c,
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
		if err := q.QueryRow(c, countSQL, args...).Scan(&total); err != nil {
			return nil, err
		}
		listSQL := sql + ` ORDER BY created_at DESC, id DESC LIMIT $` +
			strconv.Itoa(len(args)+1) + ` OFFSET $` + strconv.Itoa(len(args)+2)
		args = append(args, p.Limit, p.Offset)
		jobs, err := queryJobs(q, listSQL, args...)
		if err != nil {
			return nil, err
		}
		pointers := make([]*JobRow, 0, len(jobs))
		for i := range jobs {
			pointers = append(pointers, &jobs[i])
		}
		extras, err := loadJobDecorations(q, user.ID, pointers)
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

func queryJobs(q execQuerier, sql string, args ...any) ([]JobRow, error) {
	rows, err := q.Query(context.Background(), sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JobRow
	for rows.Next() {
		var r JobRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ParentNodeID, &r.SourceType,
			&r.FileName, &r.SourceKey, &r.Title, &r.TotalPages, &r.ProcessedPages, &r.Status,
			&r.ModelConfigID, &r.ArticleID, &r.Error, &r.CreatedAt, &r.UpdatedAt); err != nil {
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
		job, err := loadJobOwned(q, user.ID, jobID)
		if err != nil {
			return nil, err
		}
		pages, err := loadJobPages(q, job.ID)
		if err != nil {
			return nil, err
		}
		extras, err := loadJobDecorations(q, user.ID, []*JobRow{job})
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
