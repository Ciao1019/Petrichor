package kb

import (
	"context"
	"encoding/base64"
	"fmt"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbimportjob"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbimportjobpage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/ent/predicate"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/pagination"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/pdfinspector"
	"github.com/Ciao1019/Petrichor/apps/api/internal/upload"
)

func mergePageMarkdown(pages []*ent.KBImportJobPage) string {
	sorted := append([]*ent.KBImportJobPage(nil), pages...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].PageNo < sorted[j].PageNo })
	parts := make([]string, 0, len(sorted))
	for _, p := range sorted {
		if p.Markdown == nil {
			continue
		}
		text := strings.TrimSpace(*p.Markdown)
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n\n")
}

type importJobDecorations struct {
	KnowledgeBaseName *string
	ParentFolderName  *string
	PageStats         gin.H
}

func jobDTO(job *ent.KBImportJob, extra importJobDecorations) gin.H {
	donePages, failedPages, pendingPages := 0, 0, job.TotalPages
	if extra.PageStats != nil {
		donePages, _ = extra.PageStats["donePages"].(int)
		failedPages, _ = extra.PageStats["failedPages"].(int)
		pendingPages, _ = extra.PageStats["pendingPages"].(int)
	}
	var parentNodeID, modelConfigID, articleID any
	if job.ParentNodeID != nil {
		parentNodeID = fmt.Sprintf("%d", *job.ParentNodeID)
	}
	if job.ModelConfigID != nil {
		modelConfigID = fmt.Sprintf("%d", *job.ModelConfigID)
	}
	if job.ArticleID != nil {
		articleID = fmt.Sprintf("%d", *job.ArticleID)
	}
	return gin.H{
		"id":                fmt.Sprintf("%d", job.ID),
		"knowledgeBaseId":   fmt.Sprintf("%d", job.KnowledgeBaseID),
		"knowledgeBaseName": extra.KnowledgeBaseName,
		"parentNodeId":      parentNodeID,
		"parentFolderName":  extra.ParentFolderName,
		"fileName":          job.FileName,
		"title":             job.Title,
		"sourceType":        job.SourceType,
		"totalPages":        job.TotalPages,
		"processedPages":    job.ProcessedPages,
		"donePages":         donePages,
		"failedPages":       failedPages,
		"pendingPages":      pendingPages,
		"status":            job.Status,
		"modelConfigId":     modelConfigID,
		"articleId":         articleID,
		"error":             job.Error,
		"createdAt":         job.CreatedAt.UTC().Format(time.RFC3339Nano),
		"updatedAt":         job.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (h *Handler) buildPageStats(ctx *gin.Context, jobIDs []int64) (map[int64]gin.H, error) {
	out := map[int64]gin.H{}
	if len(jobIDs) == 0 {
		return out, nil
	}
	pages, err := h.svc.client.KBImportJobPage.Query().
		Where(kbimportjobpage.JobIDIn(jobIDs...)).
		All(ctx.Request.Context())
	if err != nil {
		return nil, err
	}
	for _, id := range jobIDs {
		out[id] = gin.H{"donePages": 0, "failedPages": 0, "pendingPages": 0}
	}
	for _, p := range pages {
		stats := out[p.JobID]
		switch p.Status {
		case "done":
			stats["donePages"] = stats["donePages"].(int) + 1
		case "failed":
			stats["failedPages"] = stats["failedPages"].(int) + 1
		default:
			stats["pendingPages"] = stats["pendingPages"].(int) + 1
		}
		out[p.JobID] = stats
	}
	return out, nil
}

func (h *Handler) loadImportJobDecorations(ctx context.Context, userID int64, jobs []*ent.KBImportJob, stats map[int64]gin.H) (map[int64]importJobDecorations, error) {
	kbIDs := make([]int64, 0, len(jobs))
	parentIDs := make([]int64, 0, len(jobs))
	seenKB, seenParent := make(map[int64]bool), make(map[int64]bool)
	for _, job := range jobs {
		if !seenKB[job.KnowledgeBaseID] {
			seenKB[job.KnowledgeBaseID] = true
			kbIDs = append(kbIDs, job.KnowledgeBaseID)
		}
		if job.ParentNodeID != nil && !seenParent[*job.ParentNodeID] {
			seenParent[*job.ParentNodeID] = true
			parentIDs = append(parentIDs, *job.ParentNodeID)
		}
	}
	kbNames := make(map[int64]string)
	if len(kbIDs) > 0 {
		rows, err := h.svc.client.KnowledgeBase.Query().Where(
			knowledgebase.UserIDEQ(userID), knowledgebase.IDIn(kbIDs...),
		).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			kbNames[row.ID] = row.Name
		}
	}
	parentNames := make(map[int64]string)
	if len(parentIDs) > 0 {
		rows, err := h.svc.client.KBNode.Query().Where(
			kbnode.UserIDEQ(userID), kbnode.IDIn(parentIDs...),
		).All(ctx)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			parentNames[row.ID] = row.Name
		}
	}
	out := make(map[int64]importJobDecorations, len(jobs))
	for _, job := range jobs {
		extra := importJobDecorations{PageStats: stats[job.ID]}
		if name, ok := kbNames[job.KnowledgeBaseID]; ok {
			extra.KnowledgeBaseName = &name
		}
		if job.ParentNodeID != nil {
			if name, ok := parentNames[*job.ParentNodeID]; ok {
				extra.ParentFolderName = &name
			}
		}
		out[job.ID] = extra
	}
	return out, nil
}

func (h *Handler) ListImportJobs(c *gin.Context) {
	var req struct {
		KnowledgeBaseID *string `json:"knowledgeBaseId"`
		PageNum         int     `json:"pageNum"`
		PageSize        int     `json:"pageSize"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := auth.MustUser(c)
	page := pagination.Resolve(pagination.Input{PageNum: req.PageNum, PageSize: req.PageSize})
	predicates := []predicate.KBImportJob{kbimportjob.UserIDEQ(u.ID)}
	if req.KnowledgeBaseID != nil && strings.TrimSpace(*req.KnowledgeBaseID) != "" {
		kbID, err := parsePositiveID(*req.KnowledgeBaseID, "knowledgeBaseId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		predicates = append(predicates, kbimportjob.KnowledgeBaseIDEQ(kbID))
	}
	total, err := h.svc.client.KBImportJob.Query().Where(predicates...).Count(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	rows, err := h.svc.client.KBImportJob.Query().Where(predicates...).
		Order(ent.Desc(kbimportjob.FieldCreatedAt)).
		Limit(page.Limit).Offset(page.Offset).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	stats, err := h.buildPageStats(c, ids)
	if err != nil {
		response.Fail(c, err)
		return
	}
	decorations, err := h.loadImportJobDecorations(c.Request.Context(), u.ID, rows, stats)
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		out = append(out, jobDTO(row, decorations[row.ID]))
	}
	response.TableData(c, out, total)
}

func (h *Handler) DetailImportJob(c *gin.Context) {
	var req struct {
		JobID string `json:"jobId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	jobID, err := parsePositiveID(req.JobID, "jobId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	job, err := h.svc.client.KBImportJob.Query().
		Where(kbimportjob.IDEQ(jobID), kbimportjob.UserIDEQ(u.ID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("导入任务不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	pages, err := h.svc.client.KBImportJobPage.Query().
		Where(kbimportjobpage.JobIDEQ(job.ID)).
		Order(ent.Asc(kbimportjobpage.FieldPageNo)).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	statsByJob, err := h.buildPageStats(c, []int64{job.ID})
	if err != nil {
		response.Fail(c, err)
		return
	}
	decorations, err := h.loadImportJobDecorations(c.Request.Context(), u.ID, []*ent.KBImportJob{job}, statsByJob)
	if err != nil {
		response.Fail(c, err)
		return
	}
	pageRows := make([]gin.H, 0, len(pages))
	for _, p := range pages {
		pageRows = append(pageRows, pageDTO(p))
	}
	response.OK(c, gin.H{
		"job":   jobDTO(job, decorations[job.ID]),
		"pages": pageRows,
	})
}

func (h *Handler) CreateImportJob(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string  `json:"knowledgeBaseId" binding:"required"`
		ParentID        *string `json:"parentId"`
		FileName        string  `json:"fileName" binding:"required"`
		Title           string  `json:"title" binding:"required"`
		SourceKey       string  `json:"sourceKey" binding:"required"`
		ModelConfigID   *string `json:"modelConfigId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	fileName := strings.TrimSpace(req.FileName)
	title := strings.TrimSpace(req.Title)
	sourceKey := strings.TrimSpace(req.SourceKey)
	if fileName == "" || len([]rune(fileName)) > 500 || title == "" || len([]rune(title)) > 200 || sourceKey == "" {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	var parentID *int64
	if req.ParentID != nil && strings.TrimSpace(*req.ParentID) != "" {
		id, err := parsePositiveID(*req.ParentID, "parentId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		parentID = &id
	}
	if err := h.svc.assertFolderParent(c.Request.Context(), u.ID, kbID, parentID); err != nil {
		response.Fail(c, err)
		return
	}
	kbRow, err := h.svc.client.KnowledgeBase.Query().Where(
		knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(u.ID),
	).Only(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	var parentName *string
	if parentID != nil {
		parent, err := h.svc.client.KBNode.Query().Where(
			kbnode.IDEQ(*parentID), kbnode.UserIDEQ(u.ID),
		).Only(c.Request.Context())
		if err != nil {
			response.Fail(c, err)
			return
		}
		name := parent.Name
		parentName = &name
	}

	pdfBytes, err := upload.FetchObjectBytes(c.Request.Context(), h.svc.cfg, sourceKey)
	if err != nil {
		response.Fail(c, response.BadRequest("读取上传的 PDF 失败："+err.Error()))
		return
	}
	extracted, err := pdfinspector.New(h.svc.cfg.PDFInspectorURL).Extract(c.Request.Context(), pdfBytes)
	if err != nil {
		response.Fail(c, response.BadRequest(err.Error()))
		return
	}

	ocrPageNos := make([]int, 0)
	for _, page := range extracted.Pages {
		if page.NeedsOcr {
			ocrPageNos = append(ocrPageNos, page.Page+1)
		}
	}

	builder := h.svc.client.KBImportJob.Create().
		SetUserID(u.ID).
		SetKnowledgeBaseID(kbID).
		SetSourceType("pdf").
		SetFileName(fileName).
		SetSourceKey(sourceKey).
		SetTitle(title).
		SetTotalPages(len(extracted.Pages)).
		SetProcessedPages(len(extracted.Pages) - len(ocrPageNos)).
		SetStatus("processing")
	if parentID != nil {
		builder.SetParentNodeID(*parentID)
	}
	if req.ModelConfigID != nil && strings.TrimSpace(*req.ModelConfigID) != "" {
		mid, err := parsePositiveID(*req.ModelConfigID, "modelConfigId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		builder.SetModelConfigID(mid)
	}
	job, err := builder.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}

	creates := make([]*ent.KBImportJobPageCreate, 0, len(extracted.Pages))
	for _, page := range extracted.Pages {
		pageNo := page.Page + 1
		pc := h.svc.client.KBImportJobPage.Create().
			SetJobID(job.ID).
			SetPageNo(pageNo)
		if page.NeedsOcr {
			pc.SetExtractedBy("vision").SetStatus("pending")
		} else {
			md := strings.TrimSpace(page.Markdown)
			pc.SetExtractedBy("pdf").SetStatus("done").SetMarkdown(md)
		}
		creates = append(creates, pc)
	}
	if len(creates) > 0 {
		if _, err := h.svc.client.KBImportJobPage.CreateBulk(creates...).Save(c.Request.Context()); err != nil {
			response.Fail(c, err)
			return
		}
	}

	kbName := kbRow.Name
	jobExtra := importJobDecorations{KnowledgeBaseName: &kbName, ParentFolderName: parentName}

	if len(ocrPageNos) == 0 {
		articleID, _, err := h.finalizeImportJob(c, u.ID, job)
		if err != nil {
			response.Fail(c, err)
			return
		}
		job, err = h.svc.client.KBImportJob.Get(c.Request.Context(), job.ID)
		if err != nil {
			response.Fail(c, err)
			return
		}
		jobExtra.PageStats = gin.H{
			"donePages":    len(extracted.Pages),
			"failedPages":  0,
			"pendingPages": 0,
		}
		response.OK(c, gin.H{
			"job":        jobDTO(job, jobExtra),
			"ocrPageNos": []int{},
			"isComplex":  extracted.IsComplex,
			"articleId":  fmt.Sprintf("%d", articleID),
		})
		return
	}

	jobExtra.PageStats = gin.H{
		"donePages":    len(extracted.Pages) - len(ocrPageNos),
		"failedPages":  0,
		"pendingPages": len(ocrPageNos),
	}
	response.OK(c, gin.H{
		"job":        jobDTO(job, jobExtra),
		"ocrPageNos": ocrPageNos,
		"isComplex":  extracted.IsComplex,
		"articleId":  nil,
	})
}

func (h *Handler) finalizeImportJob(c *gin.Context, userID int64, job *ent.KBImportJob) (int64, *int64, error) {
	return h.finalizeImportJobContext(c.Request.Context(), userID, job)
}

func (h *Handler) finalizeImportJobContext(ctx context.Context, userID int64, job *ent.KBImportJob) (int64, *int64, error) {
	if job.Status == "canceled" {
		return 0, nil, response.BadRequest("任务已取消")
	}
	if job.ArticleID != nil {
		return *job.ArticleID, nil, nil
	}
	pages, err := h.svc.client.KBImportJobPage.Query().
		Where(kbimportjobpage.JobIDEQ(job.ID)).
		All(ctx)
	if err != nil {
		return 0, nil, err
	}
	if len(pages) == 0 {
		return 0, nil, response.BadRequest("任务没有可合并的页面")
	}
	unfinished := 0
	for _, p := range pages {
		if p.Status != "done" {
			unfinished++
		}
	}
	if unfinished > 0 {
		return 0, nil, response.BadRequest(fmt.Sprintf("仍有 %d 页未成功转换，请先重试失败页", unfinished))
	}
	if err := h.svc.assertKBOwner(ctx, userID, job.KnowledgeBaseID); err != nil {
		return 0, nil, err
	}
	if err := h.svc.assertFolderParent(ctx, userID, job.KnowledgeBaseID, job.ParentNodeID); err != nil {
		return 0, nil, err
	}
	content := mergePageMarkdown(pages)
	sortOrder, err := h.svc.nextSortOrder(ctx, userID, job.KnowledgeBaseID, job.ParentNodeID)
	if err != nil {
		return 0, nil, err
	}
	metadata := derivePublicArticleMetadata(content)
	tx, err := h.svc.client.Tx(ctx)
	if err != nil {
		return 0, nil, err
	}
	nodeBuilder := tx.KBNode.Create().
		SetUserID(userID).
		SetKnowledgeBaseID(job.KnowledgeBaseID).
		SetType("ARTICLE").
		SetName(job.Title).
		SetSortOrder(sortOrder)
	if job.ParentNodeID != nil {
		nodeBuilder.SetParentID(*job.ParentNodeID)
	}
	node, err := nodeBuilder.Save(ctx)
	if err != nil {
		_ = tx.Rollback()
		return 0, nil, err
	}
	article, err := tx.KBArticle.Create().
		SetUserID(userID).
		SetKnowledgeBaseID(job.KnowledgeBaseID).
		SetNodeID(node.ID).
		SetTitle(job.Title).
		SetContentMd(content).
		SetPublicExcerpt(metadata.Excerpt).
		SetReadingMinutes(metadata.ReadingMinutes).
		SetTocJSON(metadata.TOCJSON).
		SetPublicContentHash(metadata.ContentHash).
		Save(ctx)
	if err != nil {
		_ = tx.Rollback()
		return 0, nil, err
	}
	_, err = tx.KBImportJob.UpdateOneID(job.ID).
		SetArticleID(article.ID).
		SetStatus("completed").
		ClearError().
		Save(ctx)
	if err != nil {
		_ = tx.Rollback()
		return 0, nil, err
	}
	if err := tx.Commit(); err != nil {
		return 0, nil, err
	}
	nodeID := node.ID
	return article.ID, &nodeID, nil
}

func (h *Handler) FinalizeImportJob(c *gin.Context) {
	var req struct {
		JobID string `json:"jobId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	jobID, err := parsePositiveID(req.JobID, "jobId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	job, err := h.svc.client.KBImportJob.Query().
		Where(kbimportjob.IDEQ(jobID), kbimportjob.UserIDEQ(u.ID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("导入任务不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	articleID, nodeID, err := h.finalizeImportJob(c, u.ID, job)
	if err != nil {
		response.Fail(c, err)
		return
	}
	var nodeIDOut any
	if nodeID != nil {
		nodeIDOut = fmt.Sprintf("%d", *nodeID)
	}
	response.OK(c, gin.H{"articleId": fmt.Sprintf("%d", articleID), "nodeId": nodeIDOut})
}

func (h *Handler) CancelImportJob(c *gin.Context) {
	var req struct {
		JobID string `json:"jobId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	jobID, err := parsePositiveID(req.JobID, "jobId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	job, err := h.loadOwnedImportJob(c, jobID, u.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if job.Status == "completed" || job.ArticleID != nil {
		response.Fail(c, response.BadRequest("任务已完成，无法取消"))
		return
	}
	if _, err := job.Update().SetStatus("canceled").Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"id": req.JobID, "status": "canceled"})
}

func (h *Handler) DeleteImportJobs(c *gin.Context) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	if len(req.IDs) == 0 || len(req.IDs) > 200 {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := auth.MustUser(c)
	ids := make([]int64, 0, len(req.IDs))
	seen := make(map[int64]bool)
	for _, raw := range req.IDs {
		id, err := parsePositiveID(raw, "id")
		if err != nil {
			response.Fail(c, err)
			return
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	ownedIDs, err := h.svc.client.KBImportJob.Query().Where(
		kbimportjob.UserIDEQ(u.ID), kbimportjob.IDIn(ids...),
	).IDs(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if len(ownedIDs) > 0 {
		if _, err := h.svc.client.KBImportJobPage.Delete().Where(kbimportjobpage.JobIDIn(ownedIDs...)).Exec(c.Request.Context()); err != nil {
			response.Fail(c, err)
			return
		}
		if _, err := h.svc.client.KBImportJob.Delete().Where(
			kbimportjob.UserIDEQ(u.ID), kbimportjob.IDIn(ownedIDs...),
		).Exec(c.Request.Context()); err != nil {
			response.Fail(c, err)
			return
		}
	}
	deleted := make([]string, 0, len(ownedIDs))
	for _, id := range ownedIDs {
		deleted = append(deleted, fmt.Sprintf("%d", id))
	}
	response.OK(c, gin.H{"deleted": deleted})
}

func (h *Handler) AttachImportOcrPages(c *gin.Context) {
	var req struct {
		JobID       string `json:"jobId" binding:"required"`
		Concurrency int    `json:"concurrency"`
		Pages       []struct {
			PageNo   int    `json:"pageNo"`
			ImageKey string `json:"imageKey"`
		} `json:"pages"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Pages) == 0 || len(req.Pages) > 2000 {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	if req.Concurrency < 0 || req.Concurrency > 8 {
		response.Fail(c, response.BadRequest("并发数必须在 1 到 8 之间"))
		return
	}
	jobID, err := parsePositiveID(req.JobID, "jobId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	job, err := h.svc.client.KBImportJob.Query().
		Where(kbimportjob.IDEQ(jobID), kbimportjob.UserIDEQ(u.ID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("导入任务不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	if job.Status == "canceled" {
		response.Fail(c, response.BadRequest("任务已取消"))
		return
	}
	if job.ArticleID != nil {
		response.Fail(c, response.BadRequest("任务已完成，无法再补充页面图片"))
		return
	}
	ocrPages, err := h.svc.client.KBImportJobPage.Query().Where(
		kbimportjobpage.JobIDEQ(job.ID), kbimportjobpage.ExtractedByEQ("vision"),
	).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	ocrPageNos := make(map[int]bool, len(ocrPages))
	for _, page := range ocrPages {
		ocrPageNos[page.PageNo] = true
	}
	attached := 0
	seen := make(map[int]bool)
	for _, page := range req.Pages {
		if page.PageNo <= 0 || strings.TrimSpace(page.ImageKey) == "" {
			response.Fail(c, response.BadRequest("请求参数错误"))
			return
		}
		if seen[page.PageNo] || !ocrPageNos[page.PageNo] {
			continue
		}
		seen[page.PageNo] = true
		n, err := h.svc.client.KBImportJobPage.Update().
			Where(
				kbimportjobpage.JobIDEQ(job.ID),
				kbimportjobpage.PageNoEQ(page.PageNo),
				kbimportjobpage.ExtractedByEQ("vision"),
			).
			SetImageKey(strings.TrimSpace(page.ImageKey)).
			SetStatus("pending").
			ClearError().
			Save(c.Request.Context())
		if err != nil {
			response.Fail(c, err)
			return
		}
		if n > 0 {
			attached++
		}
	}
	if attached == 0 {
		response.Fail(c, response.BadRequest("没有匹配的待识别页面"))
		return
	}
	if _, err := h.svc.client.KBImportJob.UpdateOneID(job.ID).SetStatus("processing").ClearError().Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	concurrency := req.Concurrency
	if concurrency <= 0 {
		concurrency = 4
	}
	h.scheduleImportJobProcessing(u.ID, job.ID, concurrency)
	response.OK(c, gin.H{"attached": attached, "status": "processing"})
}

func pageDTO(p *ent.KBImportJobPage) gin.H {
	return gin.H{
		"pageNo":      p.PageNo,
		"imageKey":    p.ImageKey,
		"extractedBy": p.ExtractedBy,
		"status":      p.Status,
		"markdown":    p.Markdown,
		"error":       p.Error,
	}
}

func imageContentTypeFromKey(objectKey string) string {
	ext := strings.ToLower(path.Ext(objectKey))
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	default:
		return "image/png"
	}
}

func toImageDataURL(objectKey string, data []byte) string {
	mime := imageContentTypeFromKey(objectKey)
	return fmt.Sprintf("data:%s;base64,%s", mime, base64.StdEncoding.EncodeToString(data))
}

func deriveImportJobStatus(statuses []string) string {
	if len(statuses) == 0 {
		return "pending"
	}
	for _, s := range statuses {
		if s == "pending" {
			return "processing"
		}
	}
	for _, s := range statuses {
		if s == "failed" {
			return "failed"
		}
	}
	return "completed"
}

func (h *Handler) refreshImportJobProgress(c *gin.Context, jobID int64) (processed int, status string, err error) {
	return h.refreshImportJobProgressContext(c.Request.Context(), jobID)
}

func (h *Handler) refreshImportJobProgressContext(ctx context.Context, jobID int64) (processed int, status string, err error) {
	pages, err := h.svc.client.KBImportJobPage.Query().
		Where(kbimportjobpage.JobIDEQ(jobID)).
		All(ctx)
	if err != nil {
		return 0, "", err
	}
	statuses := make([]string, 0, len(pages))
	for _, p := range pages {
		statuses = append(statuses, p.Status)
		if p.Status != "pending" {
			processed++
		}
	}
	status = deriveImportJobStatus(statuses)
	_, err = h.svc.client.KBImportJob.UpdateOneID(jobID).
		SetProcessedPages(processed).
		SetStatus(status).
		Save(ctx)
	return processed, status, err
}

func (h *Handler) loadOwnedImportJob(c *gin.Context, jobID int64, userID int64) (*ent.KBImportJob, error) {
	job, err := h.svc.client.KBImportJob.Query().
		Where(kbimportjob.IDEQ(jobID), kbimportjob.UserIDEQ(userID)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("导入任务不存在")
		}
		return nil, err
	}
	return job, nil
}

func (h *Handler) convertSingleImportPage(c *gin.Context, userID int64, job *ent.KBImportJob, pageNo int) (gin.H, int, string, error) {
	return h.convertSingleImportPageContext(c.Request.Context(), userID, job, pageNo)
}

func (h *Handler) convertSingleImportPageContext(ctx context.Context, userID int64, job *ent.KBImportJob, pageNo int) (gin.H, int, string, error) {
	page, err := h.svc.client.KBImportJobPage.Query().
		Where(kbimportjobpage.JobIDEQ(job.ID), kbimportjobpage.PageNoEQ(pageNo)).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, 0, "", response.NotFound("导入任务页不存在")
		}
		return nil, 0, "", err
	}
	if page.ExtractedBy != "vision" {
		return nil, 0, "", response.BadRequest("该页由 PDF 本地抽取，无需模型识别")
	}
	if page.ImageKey == nil || strings.TrimSpace(*page.ImageKey) == "" {
		return nil, 0, "", response.BadRequest("该页尚未上传整页图片")
	}
	imageKey := strings.TrimSpace(*page.ImageKey)

	imageBytes, err := upload.FetchObjectBytes(ctx, h.svc.cfg, imageKey)
	if err != nil {
		msg := truncateImportErr("读取页面图片失败："+err.Error(), 500)
		if _, updateErr := h.svc.client.KBImportJobPage.UpdateOneID(page.ID).
			SetStatus("failed").
			SetError(msg).
			Save(ctx); updateErr != nil {
			return nil, 0, "", updateErr
		}
		processed, status, refreshErr := h.refreshImportJobProgressContext(ctx, job.ID)
		if refreshErr != nil {
			return nil, 0, "", refreshErr
		}
		updated, getErr := h.svc.client.KBImportJobPage.Get(ctx, page.ID)
		if getErr != nil {
			return nil, 0, "", getErr
		}
		return pageDTO(updated), processed, status, nil
	}

	modelCfg, err := ai.ResolveVisionConfig(ctx, h.svc.client, userID, job.ModelConfigID)
	if err != nil {
		msg := truncateImportErr(err.Error(), 500)
		if _, updateErr := h.svc.client.KBImportJobPage.UpdateOneID(page.ID).
			SetStatus("failed").
			SetError(msg).
			Save(ctx); updateErr != nil {
			return nil, 0, "", updateErr
		}
		processed, status, refreshErr := h.refreshImportJobProgressContext(ctx, job.ID)
		if refreshErr != nil {
			return nil, 0, "", refreshErr
		}
		updated, getErr := h.svc.client.KBImportJobPage.Get(ctx, page.ID)
		if getErr != nil {
			return nil, 0, "", getErr
		}
		return pageDTO(updated), processed, status, nil
	}

	gen := ai.NewGeneration(h.svc.cfg)
	markdown, err := ai.CallVision(ctx, gen, modelCfg, toImageDataURL(imageKey, imageBytes))
	if err != nil {
		msg := truncateImportErr(err.Error(), 500)
		_, err = h.svc.client.KBImportJobPage.UpdateOneID(page.ID).
			SetStatus("failed").
			SetError(msg).
			Save(ctx)
	} else {
		_, err = h.svc.client.KBImportJobPage.UpdateOneID(page.ID).
			SetStatus("done").
			SetMarkdown(markdown).
			ClearError().
			Save(ctx)
	}
	if err != nil {
		return nil, 0, "", err
	}

	processed, status, err := h.refreshImportJobProgressContext(ctx, job.ID)
	if err != nil {
		return nil, 0, "", err
	}
	updated, err := h.svc.client.KBImportJobPage.Get(ctx, page.ID)
	if err != nil {
		return nil, 0, "", err
	}
	return pageDTO(updated), processed, status, nil
}

func (h *Handler) scheduleImportJobProcessing(userID, jobID int64, concurrency int) {
	go h.processImportJobInBackground(context.Background(), userID, jobID, concurrency)
}

func (h *Handler) processImportJobInBackground(ctx context.Context, userID, jobID int64, concurrency int) {
	job, err := h.svc.client.KBImportJob.Query().Where(
		kbimportjob.IDEQ(jobID), kbimportjob.UserIDEQ(userID),
	).Only(ctx)
	if err != nil || job.Status == "canceled" || job.ArticleID != nil {
		return
	}
	if _, err := job.Update().SetStatus("processing").ClearError().Save(ctx); err != nil {
		return
	}
	pages, err := h.svc.client.KBImportJobPage.Query().Where(
		kbimportjobpage.JobIDEQ(jobID),
		kbimportjobpage.StatusEQ("pending"),
		kbimportjobpage.ImageKeyNotNil(),
	).Order(ent.Asc(kbimportjobpage.FieldPageNo)).All(ctx)
	if err != nil {
		h.failImportJob(ctx, jobID, "加载待识别页面失败")
		return
	}
	if concurrency <= 0 {
		concurrency = 4
	}
	if concurrency > 8 {
		concurrency = 8
	}
	queue := make(chan *ent.KBImportJobPage)
	workerErrors := make(chan error, len(pages))
	var workers sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for page := range queue {
				latest, err := h.svc.client.KBImportJob.Query().Where(
					kbimportjob.IDEQ(jobID), kbimportjob.UserIDEQ(userID),
				).Only(ctx)
				if err != nil || latest.Status == "canceled" || latest.ArticleID != nil {
					continue
				}
				if _, _, _, err := h.convertSingleImportPageContext(ctx, userID, latest, page.PageNo); err != nil {
					workerErrors <- err
				}
			}
		}()
	}
	for _, page := range pages {
		queue <- page
	}
	close(queue)
	workers.Wait()
	close(workerErrors)
	if err := <-workerErrors; err != nil {
		h.failImportJob(ctx, jobID, err.Error())
		return
	}

	job, err = h.svc.client.KBImportJob.Query().Where(
		kbimportjob.IDEQ(jobID), kbimportjob.UserIDEQ(userID),
	).Only(ctx)
	if err != nil || job.Status == "canceled" || job.ArticleID != nil {
		return
	}
	allPages, err := h.svc.client.KBImportJobPage.Query().Where(kbimportjobpage.JobIDEQ(jobID)).All(ctx)
	if err != nil {
		h.failImportJob(ctx, jobID, "加载任务进度失败")
		return
	}
	done, failed, pending := 0, 0, 0
	for _, page := range allPages {
		switch page.Status {
		case "done":
			done++
		case "failed":
			failed++
		default:
			pending++
		}
	}
	if failed > 0 || pending > 0 {
		updater := h.svc.client.KBImportJob.UpdateOneID(jobID).SetProcessedPages(done + failed)
		if failed > 0 {
			updater.SetStatus("failed").SetError(fmt.Sprintf("有 %d 页转 Markdown 失败，请在导入任务详情中重试。", failed))
		} else {
			updater.SetStatus("processing").ClearError()
		}
		if _, err := updater.Save(ctx); err != nil {
			h.failImportJob(ctx, jobID, err.Error())
		}
		return
	}
	if _, _, err := h.finalizeImportJobContext(ctx, userID, job); err != nil {
		h.failImportJob(ctx, jobID, err.Error())
	}
}

func (h *Handler) failImportJob(ctx context.Context, jobID int64, message string) {
	_, _ = h.svc.client.KBImportJob.UpdateOneID(jobID).
		SetStatus("failed").
		SetError(truncateImportErr(message, 500)).
		Save(ctx)
}

func truncateImportErr(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// ConvertImportPage 单页 Vision OCR 转写。
func (h *Handler) ConvertImportPage(c *gin.Context) {
	var req struct {
		JobID  string `json:"jobId" binding:"required"`
		PageNo int    `json:"pageNo" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.PageNo <= 0 {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	jobID, err := parsePositiveID(req.JobID, "jobId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	job, err := h.loadOwnedImportJob(c, jobID, u.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if job.Status == "canceled" {
		response.Fail(c, response.BadRequest("任务已取消"))
		return
	}
	page, processed, status, err := h.convertSingleImportPage(c, u.ID, job, req.PageNo)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"page":           page,
		"processedPages": processed,
		"status":         status,
	})
}

// RetryImportPage 将指定页重置为 pending 后重新转换。
func (h *Handler) RetryImportPage(c *gin.Context) {
	var req struct {
		JobID  string `json:"jobId" binding:"required"`
		PageNo int    `json:"pageNo" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.PageNo <= 0 {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	jobID, err := parsePositiveID(req.JobID, "jobId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	job, err := h.loadOwnedImportJob(c, jobID, u.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if job.Status == "canceled" {
		response.Fail(c, response.BadRequest("任务已取消"))
		return
	}
	page, err := h.svc.client.KBImportJobPage.Query().
		Where(kbimportjobpage.JobIDEQ(job.ID), kbimportjobpage.PageNoEQ(req.PageNo)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("导入任务页不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	if page.ExtractedBy != "vision" {
		response.Fail(c, response.BadRequest("该页由 PDF 本地抽取，无需重试"))
		return
	}
	if page.ImageKey == nil || strings.TrimSpace(*page.ImageKey) == "" {
		response.Fail(c, response.BadRequest("该页尚未上传整页图片"))
		return
	}
	job, err = h.switchImportJobToDefaultVisionModel(c.Request.Context(), u.ID, job)
	if err != nil {
		response.Fail(c, err)
		return
	}
	_, err = h.svc.client.KBImportJobPage.UpdateOneID(page.ID).
		SetStatus("pending").
		ClearError().
		Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	outPage, processed, status, err := h.convertSingleImportPage(c, u.ID, job, req.PageNo)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"page":           outPage,
		"processedPages": processed,
		"status":         status,
	})
}

// RetryImportFailedPages 将失败页重置为 pending，返回重置数量。
func (h *Handler) RetryImportFailedPages(c *gin.Context) {
	var req struct {
		JobID string `json:"jobId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	jobID, err := parsePositiveID(req.JobID, "jobId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	job, err := h.loadOwnedImportJob(c, jobID, u.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if job.Status == "canceled" {
		response.Fail(c, response.BadRequest("任务已取消"))
		return
	}
	job, err = h.switchImportJobToDefaultVisionModel(c.Request.Context(), u.ID, job)
	if err != nil {
		response.Fail(c, err)
		return
	}
	n, err := h.svc.client.KBImportJobPage.Update().
		Where(
			kbimportjobpage.JobIDEQ(job.ID),
			kbimportjobpage.StatusEQ("failed"),
		).
		SetStatus("pending").
		ClearError().
		Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if n == 0 {
		response.Fail(c, response.BadRequest("没有需要重试的失败页"))
		return
	}
	if _, err := h.svc.client.KBImportJob.UpdateOneID(job.ID).
		SetStatus("processing").
		ClearError().
		Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	h.scheduleImportJobProcessing(u.ID, job.ID, 4)
	response.OK(c, gin.H{"retried": n, "status": "processing"})
}

func (h *Handler) switchImportJobToDefaultVisionModel(ctx context.Context, userID int64, job *ent.KBImportJob) (*ent.KBImportJob, error) {
	modelConfig, err := ai.ResolveVisionConfig(ctx, h.svc.client, userID, nil)
	if err != nil {
		return nil, err
	}
	if job.ModelConfigID != nil && *job.ModelConfigID == modelConfig.ID {
		return job, nil
	}
	return job.Update().SetModelConfigID(modelConfig.ID).Save(ctx)
}
