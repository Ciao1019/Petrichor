package kb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunk"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikidocumentref"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikiingestjob"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikilink"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const (
	wikiMaxDocumentRunes       = 32768
	wikiCitationBatchRunes     = 12000
	wikiMaxDocumentsPerBatch   = 5
	wikiCandidateStageAttempts = 2
	wikiCitationConcurrency    = 4
	wikiReduceConcurrency      = 4
	wikiAutomaticDebounce      = 30 * time.Second
	wikiWorkerPollInterval     = 2 * time.Second
	wikiModelAttempts          = 3
	wikiModelAttemptTimeout    = 150 * time.Second
	wikiContributionNotePrefix = "wiki-contribution:"
)

type wikiExtractedItem struct {
	Name         string   `json:"name"`
	Slug         string   `json:"slug"`
	Aliases      []string `json:"aliases"`
	Description  string   `json:"description"`
	Details      string   `json:"details"`
	SourceChunks []int    `json:"-"`
	Kind         string   `json:"-"`
}

type wikiExtractionResult struct {
	Entities []wikiExtractedItem `json:"entities"`
	Concepts []wikiExtractedItem `json:"concepts"`
}

type wikiCitationNewSlug struct {
	Type         string         `json:"type"`
	Name         string         `json:"name"`
	Slug         string         `json:"slug"`
	Aliases      wikiStringList `json:"aliases"`
	Description  string         `json:"description"`
	Details      string         `json:"details"`
	SourceChunks wikiStringList `json:"source_chunks"`
}

type wikiCitationResult struct {
	Citations map[string]wikiStringList `json:"citations"`
	NewSlugs  []wikiCitationNewSlug     `json:"new_slugs"`
}

// wikiStringList 兼容模型把单元素数组偶发输出为字符串的情况。
type wikiStringList []string

func (values *wikiStringList) UnmarshalJSON(raw []byte) error {
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		*values = list
		return nil
	}
	var single string
	if err := json.Unmarshal(raw, &single); err == nil {
		if strings.TrimSpace(single) == "" {
			*values = nil
		} else {
			*values = []string{single}
		}
		return nil
	}
	if string(raw) == "null" {
		*values = nil
		return nil
	}
	return fmt.Errorf("期望字符串或字符串数组")
}

type wikiDocumentMap struct {
	Document    *ent.KBDocument
	Chunks      []*ent.KBDocumentChunk
	Content     string
	Summary     string
	SummaryBody string
	Items       []wikiExtractedItem
	Warnings    []string
}

type wikiContribution struct {
	Kind        string   `json:"kind"`
	Name        string   `json:"name"`
	Aliases     []string `json:"aliases,omitempty"`
	Description string   `json:"description,omitempty"`
	Details     string   `json:"details,omitempty"`
	DocSummary  string   `json:"docSummary,omitempty"`
}

// WikiDocumentIngest 只提交持久任务，模型处理不再占用代理请求的 30 秒生命周期。
func (h *Handler) WikiDocumentIngest(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string   `json:"knowledgeBaseId" binding:"required"`
		DocumentIDs     []string `json:"documentIds"`
		ForceRebuild    bool     `json:"forceRebuild"`
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
	job, err := h.svc.QueueKnowledgeBaseDocumentsWiki(c.Request.Context(), auth.MustUser(c).ID, kbID, req.DocumentIDs, req.ForceRebuild)
	if err != nil {
		response.Fail(c, fmt.Errorf("queue wiki ingest failed (knowledge_base_id=%d): %w", kbID, err))
		return
	}
	response.OK(c, wikiJobDTO(job))
}

// WikiIngestStatus 返回指定任务，未传 jobId 时返回知识库最新任务。
func (h *Handler) WikiIngestStatus(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
		JobID           string `json:"jobId"`
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
	q := h.svc.client.KBWikiIngestJob.Query().Where(
		kbwikiingestjob.UserIDEQ(u.ID), kbwikiingestjob.KnowledgeBaseIDEQ(kbID),
	)
	if strings.TrimSpace(req.JobID) != "" {
		jobID, parseErr := parsePositiveID(req.JobID, "jobId")
		if parseErr != nil {
			response.Fail(c, parseErr)
			return
		}
		q = q.Where(kbwikiingestjob.IDEQ(jobID))
	}
	job, err := q.Order(ent.Desc(kbwikiingestjob.FieldID)).First(c.Request.Context())
	if ent.IsNotFound(err) {
		response.OK(c, gin.H{"job": nil})
		return
	}
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"job": wikiJobDTO(job)})
}

func wikiJobDTO(job *ent.KBWikiIngestJob) gin.H {
	if job == nil {
		return nil
	}
	warnings := []string{}
	_ = json.Unmarshal([]byte(job.WarningsJSON), &warnings)
	return gin.H{
		"jobId": strconv.FormatInt(job.ID, 10), "knowledgeBaseId": strconv.FormatInt(job.KnowledgeBaseID, 10),
		"status": job.Status, "totalDocuments": job.TotalDocuments, "processedDocuments": job.ProcessedDocuments,
		"phase": job.Phase, "currentDocument": job.CurrentDocument,
		"totalPages": job.TotalPages, "processedPages": job.ProcessedPages,
		"warnings": warnings, "error": job.Error, "availableAt": job.AvailableAt.UTC().Format(time.RFC3339Nano),
		"startedAt": formatTimePtr(job.StartedAt), "finishedAt": formatTimePtr(job.FinishedAt),
		"createdAt": job.CreatedAt.UTC().Format(time.RFC3339Nano), "updatedAt": job.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// QueueKnowledgeBaseDocumentsWiki 校验范围并提交 Wiki 任务。
func (s *Service) QueueKnowledgeBaseDocumentsWiki(ctx context.Context, userID, kbID int64, rawIDs []string, force bool) (*ent.KBWikiIngestJob, error) {
	if _, err := s.GetOwned(ctx, userID, kbID); err != nil {
		return nil, err
	}
	if len(rawIDs) > 500 {
		return nil, response.BadRequest("documentIds 数量不能超过 500")
	}
	ids := make([]int64, 0, len(rawIDs))
	seen := map[int64]struct{}{}
	for _, raw := range rawIDs {
		id, err := parsePositiveID(raw, "documentId")
		if err != nil {
			return nil, err
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	q := s.client.KBDocument.Query().Where(kbdocument.UserIDEQ(userID), kbdocument.KnowledgeBaseIDEQ(kbID))
	if len(ids) > 0 {
		q = q.Where(kbdocument.IDIn(ids...))
	}
	documents, err := q.Order(ent.Asc(kbdocument.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(documents) == 0 {
		return nil, response.BadRequest("知识库里还没有可构建 Wiki 的文件")
	}
	if len(ids) > 0 && len(documents) != len(ids) {
		return nil, response.BadRequest("部分文件不存在或不属于该知识库")
	}
	ids = ids[:0]
	for _, document := range documents {
		ids = append(ids, document.ID)
	}
	raw, _ := json.Marshal(ids)
	availableAt := time.Now().UTC()
	if !force {
		availableAt = availableAt.Add(wikiAutomaticDebounce)
	}
	job, err := s.client.KBWikiIngestJob.Create().SetUserID(userID).SetKnowledgeBaseID(kbID).
		SetDocumentIdsJSON(string(raw)).SetForceRebuild(force).SetTotalDocuments(len(ids)).SetAvailableAt(availableAt).Save(ctx)
	if err != nil {
		return nil, err
	}
	s.log.Info("wiki ingest queued", zap.Int64("job_id", job.ID), zap.Int64("knowledge_base_id", kbID), zap.Int("documents", len(ids)), zap.Time("available_at", availableAt))
	select {
	case s.wikiWake <- struct{}{}:
	default:
	}
	return job, nil
}

// QueueWikiCleanupAfterDocumentDelete 把"文档删除后的 Wiki 重整"排进后台队列。
//
// 重整会遍历所有实体/概念页并逐页 Reduce，每页一次模型调用——在 100+ 页的知识库上
// 同步执行等于让一次删除阻塞几分钟。这里只入队，删除接口立即返回。
// 同一知识库已有待处理的重整任务时不重复入队，连续删多个文件只会重整一次。
func (s *Service) QueueWikiCleanupAfterDocumentDelete(ctx context.Context, userID, kbID int64) (*ent.KBWikiIngestJob, error) {
	pending, err := s.client.KBWikiIngestJob.Query().Where(
		kbwikiingestjob.UserIDEQ(userID), kbwikiingestjob.KnowledgeBaseIDEQ(kbID),
		kbwikiingestjob.KindEQ("cleanup"), kbwikiingestjob.StatusEQ("pending"),
	).First(ctx)
	if err == nil && pending != nil {
		return pending, nil
	}
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	// 稍作延迟：批量删除时把多次触发合并成一次重整。
	job, err := s.client.KBWikiIngestJob.Create().SetUserID(userID).SetKnowledgeBaseID(kbID).
		SetKind("cleanup").SetAvailableAt(time.Now().UTC().Add(wikiAutomaticDebounce)).Save(ctx)
	if err != nil {
		return nil, err
	}
	s.log.Info("wiki cleanup queued", zap.Int64("job_id", job.ID), zap.Int64("knowledge_base_id", kbID))
	select {
	case s.wikiWake <- struct{}{}:
	default:
	}
	return job, nil
}

func (s *Service) runWikiWorker(ctx context.Context) {
	if ctx == nil {
		ctx = context.Background()
	}
	// 进程异常退出后允许未完成任务重新执行；Reduce 是按来源重建，重复执行是幂等的。
	if _, err := s.client.KBWikiIngestJob.Update().Where(kbwikiingestjob.StatusEQ("running")).SetStatus("pending").SetPhase("queued").
		SetProcessedDocuments(0).SetProcessedPages(0).SetTotalPages(0).ClearCurrentDocument().ClearStartedAt().Save(ctx); err != nil && ctx.Err() == nil {
		s.log.Error("wiki worker recovery failed", zap.Error(err))
	}
	ticker := time.NewTicker(wikiWorkerPollInterval)
	defer ticker.Stop()
	for {
		if err := s.drainWikiJobs(ctx); err != nil && ctx.Err() == nil {
			s.log.Error("wiki worker drain failed", zap.Error(err))
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-s.wikiWake:
		}
	}
}

func (s *Service) drainWikiJobs(ctx context.Context) error {
	for {
		job, err := s.client.KBWikiIngestJob.Query().Where(
			kbwikiingestjob.StatusEQ("pending"), kbwikiingestjob.AvailableAtLTE(time.Now().UTC()),
		).Order(ent.Asc(kbwikiingestjob.FieldAvailableAt), ent.Asc(kbwikiingestjob.FieldID)).First(ctx)
		if ent.IsNotFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		claimed, err := s.client.KBWikiIngestJob.Update().Where(
			kbwikiingestjob.IDEQ(job.ID), kbwikiingestjob.StatusEQ("pending"),
		).SetStatus("running").SetPhase(wikiClaimPhase(job.Kind)).SetStartedAt(now).ClearError().Save(ctx)
		if err != nil {
			return err
		}
		if claimed == 0 {
			continue
		}
		if err := s.processWikiJob(ctx, job.ID); err != nil {
			finished := time.Now().UTC()
			_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetStatus("failed").SetPhase("failed").SetError(truncateRunes(err.Error(), 2000)).SetFinishedAt(finished).Save(context.WithoutCancel(ctx))
			s.log.Error("wiki ingest failed", zap.Int64("job_id", job.ID), zap.Error(err))
		}
	}
}

func (s *Service) processWikiJob(ctx context.Context, jobID int64) error {
	jobStartedAt := time.Now()
	job, err := s.client.KBWikiIngestJob.Get(ctx, jobID)
	if err != nil {
		return err
	}
	kbRow, err := s.GetOwned(ctx, job.UserID, job.KnowledgeBaseID)
	if err != nil {
		return err
	}
	if job.Kind == "cleanup" {
		return s.runWikiCleanupJob(ctx, job)
	}
	var ids []int64
	if err := json.Unmarshal([]byte(job.DocumentIdsJSON), &ids); err != nil || len(ids) == 0 {
		return errors.New("wiki job document_ids_json 无效")
	}
	modelCfg, err := ai.ResolveChatConfigByID(ctx, s.client, job.UserID, kbRow.ChatModelID)
	if err != nil {
		return fmt.Errorf("解析 Wiki 对话模型: %w", err)
	}
	documents, err := s.client.KBDocument.Query().Where(
		kbdocument.UserIDEQ(job.UserID), kbdocument.KnowledgeBaseIDEQ(job.KnowledgeBaseID), kbdocument.IDIn(ids...),
	).Order(ent.Asc(kbdocument.FieldID)).All(ctx)
	if err != nil {
		return err
	}
	totalKBDocuments, err := s.client.KBDocument.Query().Where(
		kbdocument.UserIDEQ(job.UserID), kbdocument.KnowledgeBaseIDEQ(job.KnowledgeBaseID),
	).Count(ctx)
	if err != nil {
		return err
	}
	fullRebuild := len(documents) == totalKBDocuments
	s.log.Info("wiki ingest started", zap.Int64("job_id", job.ID), zap.Int64("knowledge_base_id", job.KnowledgeBaseID),
		zap.Int("documents", len(documents)), zap.Bool("full_rebuild", fullRebuild), zap.String("model", modelCfg.Model))
	warnings := []string{}
	affected := map[string]struct{}{}
	mappedDocuments := make([]*wikiDocumentMap, 0, len(documents))
	processed := 0
	for offset := 0; offset < len(documents); offset += wikiMaxDocumentsPerBatch {
		end := min(offset+wikiMaxDocumentsPerBatch, len(documents))
		// 同一对话模型上并发执行多份长文档 Map，部分 OpenAI 兼容网关会返回空 choices。
		// 文档级 Map 保持串行；单文档内部的摘要和证据批次仍并发，兼顾稳定性与吞吐。
		for _, document := range documents[offset:end] {
			mapped, mapErr := s.mapWikiDocument(ctx, job.ID, job.UserID, job.KnowledgeBaseID, document, modelCfg)
			if mapErr != nil {
				return fmt.Errorf("文档 %s Wiki Map 失败: %w", document.Title, mapErr)
			}
			mappedDocuments = append(mappedDocuments, mapped)
			warningJSON, _ := json.Marshal(uniqueTrimWarnings(append(warnings, mapped.Warnings...), 20))
			_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetPhase("mapping").
				SetCurrentDocument(mapped.Document.Title).SetWarningsJSON(string(warningJSON)).Save(ctx)
		}
	}

	// WeKnora 的批处理顺序：全部 Map 成功后再落来源引用，避免模型失败时先撤掉旧页面。
	processed = 0
	for _, mapped := range mappedDocuments {
		_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetPhase("applying").SetCurrentDocument(mapped.Document.Title).Save(ctx)
		// 判重放在写入前而不是 Map 阶段：Map 全部跑完才开始写页面，此时前面文档产出的
		// 页面已经落库，本篇文档的「小鼹鼠」才能并进上一篇建好的「Mole」。
		// 放在 Map 阶段的话，同一批次内的跨文档重复一个都合并不掉。
		mapped.Items = applyWikiDedupMerges(mapped.Items, s.deduplicateWikiItems(ctx, modelCfg, job.UserID, job.KnowledgeBaseID, mapped.Items))
		keys, applyWarnings, applyErr := s.applyWikiDocumentMap(ctx, job.UserID, job.KnowledgeBaseID, mapped, job.ForceRebuild)
		if applyErr != nil {
			return applyErr
		}
		for _, key := range keys {
			affected[key] = struct{}{}
		}
		warnings = append(warnings, mapped.Warnings...)
		warnings = append(warnings, applyWarnings...)
		processed++
		warningJSON, _ := json.Marshal(uniqueTrimWarnings(warnings, 20))
		_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetProcessedDocuments(processed).SetWarningsJSON(string(warningJSON)).Save(ctx)
	}

	reduceKeys := make([]string, 0, len(affected))
	for key := range affected {
		if !strings.HasPrefix(key, "summary/") {
			reduceKeys = append(reduceKeys, key)
		}
	}
	sort.Strings(reduceKeys)
	if err := s.reduceWikiPages(ctx, job, reduceKeys); err != nil {
		return err
	}
	if fullRebuild {
		if err := s.archiveLegacyWikiPages(ctx, job.UserID, job.KnowledgeBaseID); err != nil {
			return err
		}
	}
	if err := s.archiveUnreferencedWikiPages(ctx, job.UserID, job.KnowledgeBaseID); err != nil {
		return err
	}
	// 目录规划放在 Reduce 之后：此时页面标题和摘要都已定稿，一次规划就能让整批页面
	// 落在同一棵目录树上。规划失败不应让整个构建作废，页面只是暂时留在根目录。
	_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetPhase("organizing").ClearCurrentDocument().Save(ctx)
	if err := s.assignWikiCategories(ctx, modelCfg, job.UserID, job.KnowledgeBaseID, affected); err != nil {
		s.log.Warn("wiki taxonomy planning failed", zap.Int64("job_id", job.ID), zap.Error(err))
		warnings = append(warnings, "目录规划失败，页面暂时挂在根目录")
	}
	_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetPhase("finalizing").ClearCurrentDocument().Save(ctx)
	if err := s.finalizeWiki(ctx, job.UserID, job.KnowledgeBaseID, kbRow.Name, modelCfg, affected); err != nil {
		return err
	}
	finished := time.Now().UTC()
	warningJSON, _ := json.Marshal(uniqueTrimWarnings(warnings, 20))
	_, err = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetStatus("completed").SetPhase("completed").SetProcessedDocuments(processed).
		SetWarningsJSON(string(warningJSON)).SetFinishedAt(finished).ClearCurrentDocument().ClearError().Save(ctx)
	if err == nil {
		s.log.Info("wiki ingest completed", zap.Int64("job_id", job.ID), zap.Int("documents", processed),
			zap.Int("affected_pages", len(affected)), zap.Duration("duration", time.Since(jobStartedAt)))
	}
	return err
}

func (s *Service) mapWikiDocument(ctx context.Context, jobID, userID, kbID int64, document *ent.KBDocument, modelCfg *ent.AIModelConfig) (*wikiDocumentMap, error) {
	documentStartedAt := time.Now()
	s.log.Info("wiki map candidate extraction started", zap.Int64("job_id", jobID), zap.Int64("document_id", document.ID), zap.String("document_title", document.Title))
	chunks, err := s.client.KBDocumentChunk.Query().Where(
		kbdocumentchunk.UserIDEQ(userID), kbdocumentchunk.KnowledgeBaseIDEQ(kbID), kbdocumentchunk.DocumentIDEQ(document.ID),
	).Order(ent.Asc(kbdocumentchunk.FieldChunkIndex)).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(chunks) == 0 {
		return nil, response.BadRequest("文件没有可用分片，请先重新解析")
	}
	content := reconstructWikiContent(document, chunks, wikiMaxDocumentRunes)
	if strings.TrimSpace(content) == "" {
		return nil, response.BadRequest("文件没有可提取的文本内容")
	}
	previous := s.previousWikiSlugsForDocument(ctx, document.ID)
	extraction, err := s.extractWikiCandidates(ctx, jobID, document, modelCfg, strings.NewReplacer(
		"{{CONTENT}}", content,
		"{{PREVIOUS_SLUGS}}", previous,
	).Replace(wikiCandidateUserPrompt))
	if err != nil {
		return nil, err
	}
	items := append(append([]wikiExtractedItem{}, extraction.Entities...), extraction.Concepts...)
	s.log.Info("wiki map candidates extracted", zap.Int64("job_id", jobID), zap.Int64("document_id", document.ID),
		zap.Int("entities", len(extraction.Entities)), zap.Int("concepts", len(extraction.Concepts)), zap.Duration("elapsed", time.Since(documentStartedAt)))
	listing := renderWikiCandidateListing(items)
	var summaryRaw string
	var summaryErr error
	var citationItems []wikiExtractedItem
	var citationWarnings []string
	var citationErr error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		summaryRaw, summaryErr = s.wikiChat(ctx, modelCfg, "summary", wikiSummarySystemPrompt(), strings.NewReplacer(
			"{{CONTENT}}", content,
			"{{EXTRACTED_SLUGS}}", listing,
		).Replace(wikiSummaryUserPrompt))
	}()
	go func() {
		defer wg.Done()
		citationItems, citationWarnings, citationErr = s.classifyWikiCitations(ctx, modelCfg, items, chunks, content)
	}()
	wg.Wait()
	if summaryErr != nil {
		return nil, fmt.Errorf("文档摘要页生成失败: %w", summaryErr)
	}
	if citationErr != nil {
		return nil, fmt.Errorf("证据分片归类失败: %w", citationErr)
	}
	s.log.Info("wiki map completed", zap.Int64("job_id", jobID), zap.Int64("document_id", document.ID),
		zap.Int("cited_pages", len(citationItems)), zap.Int("chunks", len(chunks)), zap.Int("warnings", len(citationWarnings)),
		zap.Duration("elapsed", time.Since(documentStartedAt)))
	summary, summaryBody := splitWikiSummaryLine(summaryRaw)
	if summaryBody == "" {
		summaryBody = strings.TrimSpace(summaryRaw)
	}
	if summary == "" {
		summary = truncateRunes(strings.TrimSpace(markdownToPlainText(summaryBody)), 220)
	}
	return &wikiDocumentMap{
		Document: document, Chunks: chunks, Content: content, Summary: summary, SummaryBody: summaryBody,
		Items: citationItems, Warnings: citationWarnings,
	}, nil
}

// extractWikiCandidates 对完整候选抽取阶段重试。除网络错误和空响应外，JSON 损坏、
// 清洗后为空也会重新请求，避免一次异常输出让整个持久任务直接失败。
func (s *Service) extractWikiCandidates(ctx context.Context, jobID int64, document *ent.KBDocument, modelCfg *ent.AIModelConfig, userPrompt string) (wikiExtractionResult, error) {
	var lastErr error
	for stageAttempt := 1; stageAttempt <= wikiCandidateStageAttempts; stageAttempt++ {
		raw, err := s.wikiChat(ctx, modelCfg, "candidate", wikiCandidateSystemPrompt(), userPrompt)
		if err == nil {
			var result wikiExtractionResult
			if decodeErr := decodeWikiJSON(raw, &result); decodeErr != nil {
				err = fmt.Errorf("候选实体/概念 JSON 无效: %w", decodeErr)
			} else {
				result.Entities = cleanWikiItems(result.Entities, "entity")
				result.Concepts = cleanWikiItems(result.Concepts, "concept")
				if len(result.Entities)+len(result.Concepts) > 0 {
					if stageAttempt > 1 {
						s.log.Info("wiki candidate extraction recovered", zap.Int64("job_id", jobID), zap.Int64("document_id", document.ID),
							zap.Int("stage_attempt", stageAttempt))
					}
					return result, nil
				}
				err = errors.New("模型没有从文件中提取到有效实体或概念")
			}
		}
		lastErr = err
		s.log.Warn("wiki candidate extraction stage failed", zap.Int64("job_id", jobID), zap.Int64("document_id", document.ID),
			zap.String("document_title", document.Title), zap.Int("stage_attempt", stageAttempt), zap.Int("stage_attempts", wikiCandidateStageAttempts), zap.Error(err))
		if stageAttempt < wikiCandidateStageAttempts {
			select {
			case <-ctx.Done():
				return wikiExtractionResult{}, ctx.Err()
			case <-time.After(time.Duration(stageAttempt*3) * time.Second):
			}
		}
	}
	return wikiExtractionResult{}, fmt.Errorf("候选实体/概念抽取失败: %w", lastErr)
}

func reconstructWikiContent(document *ent.KBDocument, chunks []*ent.KBDocumentChunk, limit int) string {
	if document != nil && document.ExtractedText != nil && strings.TrimSpace(*document.ExtractedText) != "" {
		return truncateRunesExact(*document.ExtractedText, limit)
	}
	// 旧数据没有 extracted_text：利用 offset 去掉 overlap；再旧的数据只能按相邻块去重拼接。
	var out strings.Builder
	lastEnd := 0
	for _, chunk := range chunks {
		text := chunk.Text
		if chunk.StartOffset != nil && chunk.EndOffset != nil && *chunk.EndOffset >= *chunk.StartOffset {
			start := max(lastEnd, *chunk.StartOffset)
			skip := start - *chunk.StartOffset
			runes := []rune(text)
			if skip < len(runes) {
				text = string(runes[skip:])
			} else {
				text = ""
			}
			lastEnd = max(lastEnd, *chunk.EndOffset)
		} else if out.Len() > 0 {
			text = trimRepeatedChunkPrefix(out.String(), text, 256)
		}
		if text == "" {
			continue
		}
		if out.Len() > 0 && !strings.HasSuffix(out.String(), "\n") && !strings.HasPrefix(text, "\n") {
			out.WriteString("\n")
		}
		out.WriteString(text)
		if utf8.RuneCountInString(out.String()) >= limit {
			break
		}
	}
	return truncateRunesExact(out.String(), limit)
}

func truncateRunesExact(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func trimRepeatedChunkPrefix(previous, current string, maxRunes int) string {
	prev, cur := []rune(previous), []rune(current)
	maxLen := min(min(len(prev), len(cur)), maxRunes)
	for size := maxLen; size >= 16; size-- {
		if string(prev[len(prev)-size:]) == string(cur[:size]) {
			return string(cur[size:])
		}
	}
	return current
}

func (s *Service) previousWikiSlugsForDocument(ctx context.Context, documentID int64) string {
	refs, err := s.client.KBWikiDocumentRef.Query().Where(kbwikidocumentref.DocumentIDEQ(documentID)).All(ctx)
	if err != nil || len(refs) == 0 {
		return "(none — this is a new document)"
	}
	pageIDs := make([]int64, 0, len(refs))
	for _, ref := range refs {
		pageIDs = append(pageIDs, ref.PageID)
	}
	pages, err := s.client.KBWikiPage.Query().Where(kbwikipage.IDIn(pageIDs...), kbwikipage.KindIn("entity", "concept")).All(ctx)
	if err != nil {
		return "(none — this is a new document)"
	}
	lines := make([]string, 0, len(pages))
	for _, page := range pages {
		aliases := wikiPageAliases(page)
		lines = append(lines, fmt.Sprintf("- %s = %s (aliases: %s)", page.PageKey, page.Title, strings.Join(aliases, ", ")))
	}
	sort.Strings(lines)
	if len(lines) == 0 {
		return "(none — this is a new document)"
	}
	return strings.Join(lines, "\n")
}

func cleanWikiItems(items []wikiExtractedItem, kind string) []wikiExtractedItem {
	out := make([]wikiExtractedItem, 0, len(items))
	seen := map[string]struct{}{}
	for _, item := range items {
		item.Name = strings.TrimSpace(item.Name)
		item.Slug = normalizeTypedWikiSlug(item.Slug, kind)
		if item.Name == "" || item.Slug == "" {
			continue
		}
		if _, exists := seen[item.Slug]; exists {
			continue
		}
		seen[item.Slug] = struct{}{}
		item.Kind = kind
		item.Aliases = uniqueNonEmpty(item.Aliases)
		item.Description = truncateRunes(strings.TrimSpace(item.Description), 300)
		item.Details = truncateRunes(strings.TrimSpace(item.Details), 600)
		out = append(out, item)
	}
	return out
}

func normalizeTypedWikiSlug(raw, kind string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if strings.HasPrefix(raw, "entity/") {
		kind = "entity"
		raw = strings.TrimPrefix(raw, "entity/")
	} else if strings.HasPrefix(raw, "concept/") {
		kind = "concept"
		raw = strings.TrimPrefix(raw, "concept/")
	}
	key := normalizeWikiSlugSegment(raw)
	if key == "" {
		return ""
	}
	return kind + "/" + key
}

func normalizeWikiSlugSegment(raw string) string {
	var out strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		valid := unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '_'
		if valid {
			out.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			out.WriteRune('-')
			lastDash = true
		}
	}
	return strings.Trim(out.String(), "-")
}

func uniqueNonEmpty(values []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, value)
	}
	return out
}

func renderWikiCandidateListing(items []wikiExtractedItem) string {
	lines := make([]string, 0, len(items))
	for _, item := range items {
		alias := ""
		if len(item.Aliases) > 0 {
			alias = " (Aliases: " + strings.Join(item.Aliases, ", ") + ")"
		}
		lines = append(lines, fmt.Sprintf("- [[%s]] = %s%s", item.Slug, item.Name, alias))
	}
	return strings.Join(lines, "\n")
}

type wikiCitationBatch struct {
	chunks  []*ent.KBDocumentChunk
	handles map[string]int
}

func (s *Service) classifyWikiCitations(ctx context.Context, modelCfg *ent.AIModelConfig, candidates []wikiExtractedItem, chunks []*ent.KBDocumentChunk, documentContent string) ([]wikiExtractedItem, []string, error) {
	batches := splitWikiCitationBatches(chunks)
	if len(batches) == 0 {
		return nil, nil, errors.New("没有可用于引用归类的文本分片")
	}
	listing := renderWikiCitationCandidates(candidates)
	citationSet := map[string]map[int]struct{}{}
	newItems := map[string]wikiExtractedItem{}
	warnings := []string{}
	successfulBatches := 0
	var mu sync.Mutex
	sem := make(chan struct{}, wikiCitationConcurrency)
	var wg sync.WaitGroup
	for batchIndex, batch := range batches {
		batchIndex, batch := batchIndex, batch
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			raw, err := s.wikiChat(ctx, modelCfg, "citation", wikiCitationSystemPrompt(), strings.NewReplacer(
				"{{CANDIDATES}}", listing,
				"{{CHUNKS}}", renderWikiCitationChunks(batch),
			).Replace(wikiCitationUserPrompt))
			if err != nil {
				mu.Lock()
				warnings = append(warnings, fmt.Sprintf("分片引用批次 %d 归类失败：%v", batchIndex+1, err))
				mu.Unlock()
				return
			}
			var parsed wikiCitationResult
			if err := decodeWikiJSON(raw, &parsed); err != nil {
				mu.Lock()
				warnings = append(warnings, fmt.Sprintf("分片引用批次 %d 输出无法解析：%v", batchIndex+1, err))
				mu.Unlock()
				s.log.Warn("wiki citation output parse failed", zap.Int("batch", batchIndex+1), zap.Error(err),
					zap.String("model_output_preview", safeWikiModelOutputPreview(raw)))
				return
			}
			mu.Lock()
			defer mu.Unlock()
			successfulBatches++
			for slug, handles := range parsed.Citations {
				slug = normalizeExistingWikiSlug(slug)
				if slug == "" {
					continue
				}
				set := citationSet[slug]
				if set == nil {
					set = map[int]struct{}{}
					citationSet[slug] = set
				}
				for _, handle := range handles {
					if index, exists := batch.handles[handle]; exists {
						set[index] = struct{}{}
					}
				}
			}
			for _, item := range parsed.NewSlugs {
				kind := strings.ToLower(strings.TrimSpace(item.Type))
				if kind != "entity" && kind != "concept" {
					if strings.HasPrefix(item.Slug, "concept/") {
						kind = "concept"
					} else {
						kind = "entity"
					}
				}
				slug := normalizeTypedWikiSlug(item.Slug, kind)
				if slug == "" || strings.TrimSpace(item.Name) == "" {
					continue
				}
				mapped := newItems[slug]
				if mapped.Slug == "" {
					mapped = wikiExtractedItem{Name: strings.TrimSpace(item.Name), Slug: slug, Kind: kind, Aliases: uniqueNonEmpty([]string(item.Aliases)), Description: item.Description, Details: item.Details}
				}
				seen := map[int]struct{}{}
				for _, index := range mapped.SourceChunks {
					seen[index] = struct{}{}
				}
				for _, handle := range item.SourceChunks {
					if index, exists := batch.handles[handle]; exists {
						if _, duplicate := seen[index]; !duplicate {
							mapped.SourceChunks = append(mapped.SourceChunks, index)
							seen[index] = struct{}{}
						}
					}
				}
				newItems[slug] = mapped
			}
		}()
	}
	wg.Wait()
	if successfulBatches == 0 {
		return nil, uniqueTrimWarnings(warnings, 20), errors.New("所有证据分片批次均未成功，已保留现有 Wiki 页面")
	}
	out := make([]wikiExtractedItem, 0, len(candidates)+len(newItems))
	seen := map[string]struct{}{}
	for _, item := range candidates {
		set := citationSet[item.Slug]
		for index := range set {
			item.SourceChunks = append(item.SourceChunks, index)
		}
		sort.Ints(item.SourceChunks)
		item.SourceChunks = validateWikiCitationEvidence(item, item.SourceChunks, chunks, documentContent)
		if len(item.SourceChunks) == 0 {
			warnings = append(warnings, item.Name+" 不满足 STANDARD 实质讨论规则，已跳过页面生成")
			continue
		}
		seen[item.Slug] = struct{}{}
		out = append(out, item)
	}
	newKeys := make([]string, 0, len(newItems))
	for key := range newItems {
		newKeys = append(newKeys, key)
	}
	sort.Strings(newKeys)
	for _, key := range newKeys {
		if _, exists := seen[key]; exists {
			continue
		}
		item := newItems[key]
		sort.Ints(item.SourceChunks)
		item.SourceChunks = validateWikiCitationEvidence(item, item.SourceChunks, chunks, documentContent)
		if len(item.SourceChunks) > 0 {
			out = append(out, item)
		}
	}
	return out, uniqueTrimWarnings(warnings, 20), nil
}

func splitWikiCitationBatches(chunks []*ent.KBDocumentChunk) []wikiCitationBatch {
	filtered := make([]*ent.KBDocumentChunk, 0, len(chunks))
	for _, chunk := range chunks {
		if chunk != nil && strings.TrimSpace(chunk.Text) != "" {
			filtered = append(filtered, chunk)
		}
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].ChunkIndex < filtered[j].ChunkIndex })
	batches := []wikiCitationBatch{}
	current := wikiCitationBatch{handles: map[string]int{}}
	length := 0
	flush := func() {
		if len(current.chunks) == 0 {
			return
		}
		batches = append(batches, current)
		current = wikiCitationBatch{handles: map[string]int{}}
		length = 0
	}
	for _, chunk := range filtered {
		chunkLength := utf8.RuneCountInString(chunk.Text)
		if len(current.chunks) > 0 && length+chunkLength > wikiCitationBatchRunes {
			flush()
		}
		handle := fmt.Sprintf("c%03d", len(current.chunks))
		current.handles[handle] = chunk.ChunkIndex
		current.chunks = append(current.chunks, chunk)
		length += chunkLength
	}
	flush()
	return batches
}

const wikiMaximumEvidenceChunks = 8

type wikiEvidenceScore struct {
	index int
	score int
}

// validateWikiCitationEvidence 对模型引用做确定性二次校验：必须出现页面名或精确别名，
// 并限制到最相关的少量分片，避免模型把整篇产品教程都挂到“终端”等宽泛页面上。
func validateWikiCitationEvidence(item wikiExtractedItem, indexes []int, chunks []*ent.KBDocumentChunk, documentContent string) []int {
	terms := wikiEvidenceTerms(item)
	if len(terms) == 0 || len(indexes) == 0 {
		return nil
	}
	byIndex := make(map[int]*ent.KBDocumentChunk, len(chunks))
	for _, chunk := range chunks {
		if chunk != nil {
			byIndex[chunk.ChunkIndex] = chunk
		}
	}
	scores := make([]wikiEvidenceScore, 0, len(indexes))
	for _, index := range uniqueSortedInts(indexes) {
		chunk := byIndex[index]
		if chunk == nil {
			continue
		}
		score := wikiChunkEvidenceScore(chunk, terms)
		if score > 0 {
			scores = append(scores, wikiEvidenceScore{index: index, score: score})
		}
	}
	if len(scores) == 0 {
		return nil
	}

	// STANDARD 与 WeKnora 一致：主主题可保留；次要项目必须有两次点名，或独立标题/段落/多条内容。
	mentions := wikiTermOccurrences(documentContent, terms)
	strong := false
	for _, scored := range scores {
		if wikiChunkHasDedicatedDiscussion(byIndex[scored.index], terms) {
			strong = true
			break
		}
	}
	if mentions < 2 && !strong {
		return nil
	}
	sort.Slice(scores, func(i, j int) bool {
		if scores[i].score != scores[j].score {
			return scores[i].score > scores[j].score
		}
		return scores[i].index < scores[j].index
	})
	if len(scores) > wikiMaximumEvidenceChunks {
		scores = scores[:wikiMaximumEvidenceChunks]
	}
	out := make([]int, len(scores))
	for index, scored := range scores {
		out[index] = scored.index
	}
	sort.Ints(out)
	return out
}

// wikiEvidenceTerms 除完整名称和别名外，还保留混合中英文标题里的可辨识核心词。
// 例如“Touch ID 授权”的正文通常只写“Touch ID”，“Shell 自动补全”的说明只重复
// “自动补全”。WeKnora 的证据模型按语义判断，不能用完整字符串硬匹配把这类独立小节误删。
func wikiEvidenceTerms(item wikiExtractedItem) []string {
	values := append([]string{item.Name}, item.Aliases...)
	name := strings.TrimSpace(item.Name)
	if name == "" {
		return uniqueWikiEvidenceTerms(values)
	}
	for _, match := range regexp.MustCompile(`[A-Za-z][A-Za-z0-9.+#_-]*(?:\s+[A-Za-z0-9.+#_-]+)*`).FindAllString(name, -1) {
		match = strings.TrimSpace(match)
		if len(match) >= 4 && !strings.EqualFold(match, "shell") {
			values = append(values, match)
		}
	}
	for _, suffix := range []string{"自动补全", "智能补全", "身份认证", "指纹认证"} {
		if strings.Contains(name, suffix) {
			values = append(values, suffix)
		}
	}
	return uniqueWikiEvidenceTerms(values)
}

func uniqueWikiEvidenceTerms(values []string) []string {
	seen := map[string]struct{}{}
	terms := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if utf8.RuneCountInString(value) < 2 {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		terms = append(terms, value)
	}
	sort.SliceStable(terms, func(i, j int) bool { return utf8.RuneCountInString(terms[i]) > utf8.RuneCountInString(terms[j]) })
	return terms
}

func wikiTermOccurrences(content string, terms []string) int {
	content = markdownFenceRE.ReplaceAllString(strings.ToLower(content), " ")
	compactContent := wikiCompactEvidenceText(content)
	count := 0
	for _, term := range terms {
		termCount := strings.Count(content, term)
		if compactTerm := wikiCompactEvidenceText(term); compactTerm != "" {
			termCount = max(termCount, strings.Count(compactContent, compactTerm))
		}
		count += termCount
	}
	return count
}

func wikiChunkEvidenceScore(chunk *ent.KBDocumentChunk, terms []string) int {
	if chunk == nil {
		return 0
	}
	text := markdownFenceRE.ReplaceAllString(strings.ToLower(chunk.Text), " ")
	compactText := wikiCompactEvidenceText(text)
	header := ""
	if chunk.ContextHeader != nil {
		header = strings.ToLower(*chunk.ContextHeader)
	}
	score := 0
	for _, term := range terms {
		occurrences := strings.Count(text, term)
		if compactTerm := wikiCompactEvidenceText(term); compactTerm != "" {
			occurrences = max(occurrences, strings.Count(compactText, compactTerm))
		}
		score += occurrences * 10
		if strings.Contains(header, term) {
			score += 20
		}
	}
	if wikiChunkHasDedicatedDiscussion(chunk, terms) {
		score += 30
	}
	return score
}

func wikiChunkHasDedicatedDiscussion(chunk *ent.KBDocumentChunk, terms []string) bool {
	if chunk == nil {
		return false
	}
	lines := strings.Split(strings.ToLower(chunk.Text), "\n")
	for lineIndex, line := range lines {
		trimmed := strings.TrimSpace(line)
		matched := false
		compactLine := wikiCompactEvidenceText(trimmed)
		for _, term := range terms {
			if strings.Contains(trimmed, term) || strings.Contains(compactLine, wikiCompactEvidenceText(term)) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "**") && strings.HasSuffix(trimmed, "**") {
			following := strings.TrimSpace(strings.Join(lines[lineIndex+1:min(lineIndex+8, len(lines))], "\n"))
			if utf8.RuneCountInString(following) >= 50 {
				return true
			}
		}
	}
	return false
}

func wikiCompactEvidenceText(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, value)
}

func renderWikiCitationCandidates(items []wikiExtractedItem) string {
	var out strings.Builder
	for _, item := range items {
		fmt.Fprintf(&out, "- slug: %s, type: %s, name: %q, aliases: %q, description: %s\n", item.Slug, item.Kind, item.Name, strings.Join(item.Aliases, ", "), item.Description)
	}
	return out.String()
}

func renderWikiCitationChunks(batch wikiCitationBatch) string {
	var out strings.Builder
	for index, chunk := range batch.chunks {
		handle := fmt.Sprintf("c%03d", index)
		fmt.Fprintf(&out, "<c id=%q index=%q", handle, strconv.Itoa(chunk.ChunkIndex))
		if chunk.ContextHeader != nil && strings.TrimSpace(*chunk.ContextHeader) != "" {
			fmt.Fprintf(&out, " context=%q", *chunk.ContextHeader)
		}
		out.WriteString(">\n")
		out.WriteString(chunk.Text)
		out.WriteString("\n</c>\n")
	}
	return out.String()
}

func normalizeExistingWikiSlug(raw string) string {
	raw = strings.TrimSpace(strings.ToLower(raw))
	for _, kind := range []string{"entity", "concept"} {
		if strings.HasPrefix(raw, kind+"/") {
			return normalizeTypedWikiSlug(raw, kind)
		}
	}
	return ""
}

func splitWikiSummaryLine(raw string) (string, string) {
	raw = strings.TrimSpace(raw)
	lines := strings.Split(raw, "\n")
	if len(lines) == 0 {
		return "", ""
	}
	first := strings.TrimSpace(lines[0])
	if strings.HasPrefix(strings.ToUpper(first), "SUMMARY:") {
		return strings.TrimSpace(first[len("SUMMARY:"):]), strings.TrimSpace(strings.Join(lines[1:], "\n"))
	}
	return "", raw
}

func decodeWikiJSON(raw string, target any) error {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	start, end := strings.Index(raw, "{"), strings.LastIndex(raw, "}")
	if start >= 0 && end > start {
		raw = raw[start : end+1]
	}
	return json.Unmarshal([]byte(sanitizeWikiJSONString(raw)), target)
}

func safeWikiModelOutputPreview(raw string) string {
	raw = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			return ' '
		}
		return r
	}, strings.TrimSpace(raw))
	return truncateRunes(raw, 600)
}

// 模型偶尔在 JSON 字符串中输出未转义换行；与 WeKnora cleanLLMJSON 保持相同容错。
func sanitizeWikiJSONString(raw string) string {
	var out strings.Builder
	out.Grow(len(raw))
	inString, escaped := false, false
	for _, r := range raw {
		if escaped {
			if r == '\n' {
				out.WriteRune('n')
			} else if r == '\r' {
				out.WriteRune('r')
			} else if r == '\t' {
				out.WriteRune('t')
			} else {
				out.WriteRune(r)
			}
			escaped = false
			continue
		}
		if r == '\\' {
			escaped = true
			out.WriteRune(r)
			continue
		}
		if r == '"' {
			inString = !inString
			out.WriteRune(r)
			continue
		}
		if inString {
			switch r {
			case '\n':
				out.WriteString(`\n`)
				continue
			case '\r':
				out.WriteString(`\r`)
				continue
			case '\t':
				out.WriteString(`\t`)
				continue
			}
		}
		out.WriteRune(r)
	}
	return out.String()
}

func (s *Service) wikiChat(ctx context.Context, modelCfg *ent.AIModelConfig, operation, systemPrompt, userPrompt string) (string, error) {
	var lastErr error
	for attempt := 0; attempt < wikiModelAttempts; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Duration(1<<uint(attempt-1)) * time.Second):
			}
		}
		attemptStartedAt := time.Now()
		attemptCtx, cancel := context.WithTimeout(ctx, wikiModelAttemptTimeout)
		result, err := ai.NewGeneration(s.cfg).Chat(attemptCtx, modelCfg, []ai.ChatMessage{{Role: "system", Content: systemPrompt}, {Role: "user", Content: userPrompt}})
		cancel()
		if err == nil {
			// 推理模型（deepseek-r1/v4-flash 这类）会把输出放进 reasoning_content，
			// content 反而是空的。只认 content 会让整个构建在能用的输出面前直接失败，
			// 所以 content 为空时回退用推理内容——后续 JSON 解析本来就会做清洗。
			content := strings.TrimSpace(result.Content)
			usedReasoning := false
			if content == "" && result.Reasoning != nil {
				content = strings.TrimSpace(*result.Reasoning)
				usedReasoning = content != ""
			}
			if content != "" {
				if usedReasoning {
					s.log.Info("wiki model fell back to reasoning content", zap.String("operation", operation),
						zap.String("model", modelCfg.Model), zap.Int("chars", len([]rune(content))))
				}
				if attempt > 0 {
					s.log.Info("wiki model request recovered", zap.String("operation", operation), zap.String("model", modelCfg.Model),
						zap.Int("attempt", attempt+1), zap.Duration("elapsed", time.Since(attemptStartedAt)))
				}
				return content, nil
			}
			reasoningChars := 0
			if result.Reasoning != nil {
				reasoningChars = len([]rune(*result.Reasoning))
			}
			// 记下用量，便于区分"模型没输出"和"输出被 token 上限截断"。
			s.log.Warn("wiki model returned empty content", zap.String("operation", operation), zap.String("model", modelCfg.Model),
				zap.Int("reasoning_chars", reasoningChars), zap.Int("output_tokens", result.Usage.OutputTokens),
				zap.Int("input_tokens", result.Usage.InputTokens), zap.String("raw_preview", safeWikiModelOutputPreview(string(result.Raw))))
			err = errors.New("模型返回空内容")
		}
		lastErr = err
		s.log.Warn("wiki model request failed", zap.String("operation", operation), zap.String("model", modelCfg.Model),
			zap.Int("attempt", attempt+1), zap.Int("attempts", wikiModelAttempts), zap.Duration("elapsed", time.Since(attemptStartedAt)), zap.Error(err))
	}
	return "", lastErr
}

func (s *Service) applyWikiDocumentMap(ctx context.Context, userID, kbID int64, mapped *wikiDocumentMap, force bool) ([]string, []string, error) {
	if mapped == nil || mapped.Document == nil {
		return nil, nil, errors.New("Wiki Map 结果为空")
	}
	oldRefs, err := s.client.KBWikiDocumentRef.Query().Where(kbwikidocumentref.DocumentIDEQ(mapped.Document.ID)).All(ctx)
	if err != nil {
		return nil, nil, err
	}
	oldPageIDs := make([]int64, 0, len(oldRefs))
	for _, ref := range oldRefs {
		oldPageIDs = append(oldPageIDs, ref.PageID)
	}
	oldPages := map[int64]*ent.KBWikiPage{}
	if len(oldPageIDs) > 0 {
		rows, loadErr := s.client.KBWikiPage.Query().Where(kbwikipage.IDIn(oldPageIDs...)).All(ctx)
		if loadErr != nil {
			return nil, nil, loadErr
		}
		for _, page := range rows {
			oldPages[page.ID] = page
		}
	}
	affected := map[string]struct{}{}
	for _, page := range oldPages {
		affected[page.PageKey] = struct{}{}
	}
	if _, err := s.client.KBWikiDocumentRef.Delete().Where(kbwikidocumentref.DocumentIDEQ(mapped.Document.ID)).Exec(ctx); err != nil {
		return nil, nil, err
	}

	allIndexes := make([]int, 0, len(mapped.Chunks))
	for _, chunk := range mapped.Chunks {
		allIndexes = append(allIndexes, chunk.ChunkIndex)
	}
	summarySlug := fmt.Sprintf("summary/%d", mapped.Document.ID)
	summaryPage, err := s.upsertCompiledWikiPage(ctx, userID, kbID, summarySlug, mapped.Document.Title, "summary", mapped.Summary, mapped.SummaryBody, nil, force)
	if err != nil {
		return nil, nil, err
	}
	// 把摘要回写到文件本身：文件卡片和悬浮预览读的是 document.summary，
	// 只写 Wiki 页面的话，列表里永远只能显示"已解析为 N 个分片"这种占位文案。
	if digest := buildDocumentSummaryDigest(mapped.Summary, mapped.SummaryBody); digest != "" {
		if _, err := s.client.KBDocument.UpdateOneID(mapped.Document.ID).SetSummary(digest).Save(ctx); err != nil {
			s.log.Warn("回写文件摘要失败", zap.Int64("document_id", mapped.Document.ID), zap.Error(err))
		}
	}
	summaryContribution := wikiContribution{Kind: "summary", Name: mapped.Document.Title, Description: mapped.Summary, Details: mapped.SummaryBody}
	if err := s.createWikiContributionRef(ctx, summaryPage.ID, mapped.Document.ID, allIndexes, summaryContribution); err != nil {
		return nil, nil, err
	}
	affected[summarySlug] = struct{}{}

	for _, item := range mapped.Items {
		page, upsertErr := s.upsertCompiledWikiPage(ctx, userID, kbID, item.Slug, item.Name, item.Kind, item.Description, "# "+item.Name+"\n\n"+item.Details, item.Aliases, force)
		if upsertErr != nil {
			return nil, nil, upsertErr
		}
		contribution := wikiContribution{Kind: item.Kind, Name: item.Name, Aliases: item.Aliases, Description: item.Description, Details: item.Details, DocSummary: mapped.SummaryBody}
		if err := s.createWikiContributionRef(ctx, page.ID, mapped.Document.ID, item.SourceChunks, contribution); err != nil {
			return nil, nil, err
		}
		affected[item.Slug] = struct{}{}
	}

	keys := make([]string, 0, len(affected))
	for key := range affected {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, nil, nil
}

func (s *Service) reduceWikiPages(ctx context.Context, job *ent.KBWikiIngestJob, keys []string) error {
	if len(keys) == 0 {
		_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetPhase("reducing").SetTotalPages(0).SetProcessedPages(0).ClearCurrentDocument().Save(ctx)
		return nil
	}
	_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetPhase("reducing").SetTotalPages(len(keys)).SetProcessedPages(0).ClearCurrentDocument().Save(ctx)
	s.log.Info("wiki reduce started", zap.Int64("job_id", job.ID), zap.Int("pages", len(keys)), zap.Int("concurrency", wikiReduceConcurrency))

	sem := make(chan struct{}, wikiReduceConcurrency)
	errCh := make(chan error, len(keys))
	var wg sync.WaitGroup
	var progressMu sync.Mutex
	processedPages := 0
	for _, key := range keys {
		key := key
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				errCh <- ctx.Err()
				return
			}
			startedAt := time.Now()
			if err := s.reduceWikiPageFromContributions(ctx, job.UserID, job.KnowledgeBaseID, key); err != nil {
				errCh <- fmt.Errorf("Reduce 页面 %s: %w", key, err)
				return
			}
			progressMu.Lock()
			processedPages++
			progress := processedPages
			progressMu.Unlock()
			_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetProcessedPages(progress).SetCurrentDocument(key).Save(ctx)
			s.log.Info("wiki reduce page completed", zap.Int64("job_id", job.ID), zap.String("page_key", key),
				zap.Int("processed_pages", progress), zap.Int("total_pages", len(keys)), zap.Duration("elapsed", time.Since(startedAt)))
		}()
	}
	wg.Wait()
	close(errCh)
	for reduceErr := range errCh {
		if reduceErr != nil {
			return reduceErr
		}
	}
	return nil
}

// archiveLegacyWikiPages 只在覆盖整个知识库的 Map 全部成功后运行，撤下旧同步管线留下的 source/document-* 与无类型前缀页面。
func (s *Service) archiveLegacyWikiPages(ctx context.Context, userID, kbID int64) error {
	pages, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
	).All(ctx)
	if err != nil {
		return err
	}
	archived := 0
	for _, page := range pages {
		legacy := page.Kind == "source" || strings.HasPrefix(page.PageKey, "document-") ||
			(page.Kind == "entity" && !strings.HasPrefix(page.PageKey, "entity/")) ||
			(page.Kind == "concept" && !strings.HasPrefix(page.PageKey, "concept/"))
		if !legacy {
			continue
		}
		if err := s.archiveWikiPage(ctx, userID, kbID, page); err != nil {
			return err
		}
		archived++
	}
	if archived > 0 {
		s.log.Info("legacy wiki pages archived", zap.Int64("knowledge_base_id", kbID), zap.Int("pages", archived))
	}
	return nil
}

func (s *Service) upsertCompiledWikiPage(ctx context.Context, userID, kbID int64, key, title, kind, summary, content string, aliases []string, force bool) (*ent.KBWikiPage, error) {
	key = normalizeWikiPageKey(key)
	content = strings.TrimSpace(content)
	if content == "" {
		content = "# " + title
	}
	frontmatter, _ := json.Marshal(map[string]any{"aliases": uniqueNonEmpty(aliases), "generatedBy": "weknora-compatible-pipeline"})
	hash := hashText(content)
	existing, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.PageKeyEQ(key),
	).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if existing != nil {
		if !force && existing.ContentHash == hash && existing.Kind == kind {
			return existing, nil
		}
		return existing.Update().SetTitle(title).SetKind(kind).SetSummary(strings.TrimSpace(summary)).SetContentMd(content).
			SetFrontmatterJSON(string(frontmatter)).SetContentHash(hash).SetVersion(existing.Version + 1).ClearArchivedAt().Save(ctx)
	}
	return s.client.KBWikiPage.Create().SetUserID(userID).SetKnowledgeBaseID(kbID).SetPageKey(key).SetTitle(title).SetKind(kind).
		SetSummary(strings.TrimSpace(summary)).SetContentMd(content).SetFrontmatterJSON(string(frontmatter)).SetContentHash(hash).SetVersion(1).Save(ctx)
}

func (s *Service) createWikiContributionRef(ctx context.Context, pageID, documentID int64, indexes []int, contribution wikiContribution) error {
	indexes = uniqueSortedInts(indexes)
	rawIndexes, _ := json.Marshal(indexes)
	rawContribution, _ := json.Marshal(contribution)
	return s.client.KBWikiDocumentRef.Create().SetPageID(pageID).SetDocumentID(documentID).SetChunkIndexesJSON(string(rawIndexes)).
		SetNote(wikiContributionNotePrefix + string(rawContribution)).Exec(ctx)
}

func uniqueSortedInts(values []int) []int {
	seen := map[int]struct{}{}
	out := make([]int, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	sort.Ints(out)
	return out
}

func (s *Service) reduceWikiPageFromContributions(ctx context.Context, userID, kbID int64, pageKey string) error {
	page, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.PageKeyEQ(pageKey),
	).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil
		}
		return err
	}
	refs, err := s.client.KBWikiDocumentRef.Query().Where(kbwikidocumentref.PageIDEQ(page.ID)).Order(ent.Asc(kbwikidocumentref.FieldDocumentID)).All(ctx)
	if err != nil {
		return err
	}
	if len(refs) == 0 {
		return nil
	}
	documentIDs := make([]int64, 0, len(refs))
	for _, ref := range refs {
		documentIDs = append(documentIDs, ref.DocumentID)
	}
	documents, err := s.client.KBDocument.Query().Where(kbdocument.IDIn(documentIDs...), kbdocument.UserIDEQ(userID)).All(ctx)
	if err != nil {
		return err
	}
	docByID := map[int64]*ent.KBDocument{}
	for _, document := range documents {
		docByID[document.ID] = document
	}
	allAliases := wikiPageAliases(page)
	var sourceContexts, evidence strings.Builder
	for _, ref := range refs {
		document := docByID[ref.DocumentID]
		if document == nil {
			continue
		}
		contribution := parseWikiContribution(ref.Note)
		allAliases = append(allAliases, contribution.Aliases...)
		if contribution.DocSummary != "" {
			fmt.Fprintf(&sourceContexts, "<document><title>%s</title><context>%s</context></document>\n", document.Title, contribution.DocSummary)
		}
		indexes := []int{}
		if ref.ChunkIndexesJSON != nil {
			_ = json.Unmarshal([]byte(*ref.ChunkIndexesJSON), &indexes)
		}
		chunks, loadErr := s.client.KBDocumentChunk.Query().Where(
			kbdocumentchunk.DocumentIDEQ(document.ID), kbdocumentchunk.ChunkIndexIn(indexes...),
		).Order(ent.Asc(kbdocumentchunk.FieldChunkIndex)).All(ctx)
		if loadErr != nil {
			return loadErr
		}
		fmt.Fprintf(&evidence, "<document><title>%s</title><content>\n", document.Title)
		for _, chunk := range chunks {
			if chunk.ContextHeader != nil && strings.TrimSpace(*chunk.ContextHeader) != "" {
				evidence.WriteString(*chunk.ContextHeader + "\n\n")
			}
			evidence.WriteString(chunk.Text + "\n\n")
		}
		evidence.WriteString("</content></document>\n")
	}
	validPages, _ := s.client.KBWikiPage.Query().Where(kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil()).All(ctx)
	var validLinks strings.Builder
	for _, validPage := range validPages {
		if validPage.PageKey != page.PageKey {
			fmt.Fprintf(&validLinks, "- %s (%s)\n", validPage.PageKey, validPage.Title)
		}
	}
	kbRow, err := s.GetOwned(ctx, userID, kbID)
	if err != nil {
		return err
	}
	modelCfg, err := ai.ResolveChatConfigByID(ctx, s.client, userID, kbRow.ChatModelID)
	if err != nil {
		return err
	}
	userPrompt := strings.NewReplacer(
		"{{SOURCE_CONTEXTS}}", sourceContexts.String(), "{{SLUG}}", page.PageKey, "{{TITLE}}", page.Title,
		"{{TYPE}}", page.Kind, "{{ALIASES}}", strings.Join(uniqueNonEmpty(allAliases), ", "),
		"{{EVIDENCE}}", evidence.String(), "{{VALID_LINKS}}", validLinks.String(),
	).Replace(wikiPageReduceUserPrompt)
	raw, err := s.wikiChat(ctx, modelCfg, "reduce", wikiPageReduceSystemPrompt(), userPrompt)
	if err != nil {
		return fmt.Errorf("Reduce 页面 %s: %w", page.PageKey, err)
	}
	summary, body := splitWikiSummaryLine(raw)
	if body == "" {
		body = strings.TrimSpace(raw)
	}
	aliases := uniqueNonEmpty(allAliases)
	frontmatter, _ := json.Marshal(map[string]any{"aliases": aliases, "generatedBy": "weknora-compatible-pipeline"})
	_, err = page.Update().SetSummary(summary).SetContentMd(stripInlineChunkHandles(body)).SetFrontmatterJSON(string(frontmatter)).
		SetContentHash(hashText(stripInlineChunkHandles(body))).SetVersion(page.Version + 1).ClearArchivedAt().Save(ctx)
	return err
}

func parseWikiContribution(note *string) wikiContribution {
	if note == nil || !strings.HasPrefix(*note, wikiContributionNotePrefix) {
		return wikiContribution{}
	}
	var contribution wikiContribution
	_ = json.Unmarshal([]byte(strings.TrimPrefix(*note, wikiContributionNotePrefix)), &contribution)
	return contribution
}

func wikiPageAliases(page *ent.KBWikiPage) []string {
	if page == nil || page.FrontmatterJSON == nil {
		return nil
	}
	var frontmatter struct {
		Aliases []string `json:"aliases"`
	}
	_ = json.Unmarshal([]byte(*page.FrontmatterJSON), &frontmatter)
	return uniqueNonEmpty(frontmatter.Aliases)
}

var inlineChunkHandlePattern = regexp.MustCompile(`[ \t]*\[c\d{3,}(?:\s*[,;]\s*c\d{3,})*\]`)

func stripInlineChunkHandles(content string) string {
	return inlineChunkHandlePattern.ReplaceAllString(content, "")
}

func (s *Service) archiveUnreferencedWikiPages(ctx context.Context, userID, kbID int64) error {
	pages, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(), kbwikipage.KindNotIn("index"),
	).All(ctx)
	if err != nil {
		return err
	}
	for _, page := range pages {
		count, countErr := s.client.KBWikiDocumentRef.Query().Where(kbwikidocumentref.PageIDEQ(page.ID)).Count(ctx)
		if countErr != nil {
			return countErr
		}
		if count > 0 {
			continue
		}
		if err := s.archiveWikiPage(ctx, userID, kbID, page); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) archiveWikiPage(ctx context.Context, userID, kbID int64, page *ent.KBWikiPage) error {
	if page == nil {
		return nil
	}
	if _, err := page.Update().SetArchivedAt(time.Now().UTC()).Save(ctx); err != nil {
		return err
	}
	_, err := s.client.KBWikiLink.Delete().Where(kbwikilink.Or(
		kbwikilink.FromPageIDEQ(page.ID),
		kbwikilink.And(kbwikilink.UserIDEQ(userID), kbwikilink.KnowledgeBaseIDEQ(kbID), kbwikilink.ToPageKeyEQ(page.PageKey)),
	)).Exec(ctx)
	return err
}

func (s *Service) finalizeWiki(ctx context.Context, userID, kbID int64, kbName string, _ *ent.AIModelConfig, affected map[string]struct{}) error {
	pages, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
	).Order(ent.Asc(kbwikipage.FieldKind), ent.Asc(kbwikipage.FieldTitle)).All(ctx)
	if err != nil {
		return err
	}
	refs := make([]wikiLinkRef, 0, len(pages)*2)
	valid := map[string]*ent.KBWikiPage{}
	for _, page := range pages {
		valid[page.PageKey] = page
		if page.Kind == "entity" || page.Kind == "concept" {
			refs = append(refs, wikiLinkRef{slug: page.PageKey, text: page.Title})
			for _, alias := range wikiPageAliases(page) {
				refs = append(refs, wikiLinkRef{slug: page.PageKey, text: alias})
			}
		}
	}
	for _, page := range pages {
		if page.Kind == "index" {
			continue
		}
		content := page.ContentMd
		if _, shouldLink := affected[page.PageKey]; shouldLink || page.Kind == "summary" {
			content, _ = linkifyWikiContent(content, refs, page.PageKey)
		}
		links := extractValidWikiLinks(content, page.PageKey, valid)
		if content != page.ContentMd {
			updated, updateErr := page.Update().SetContentMd(content).SetContentHash(hashText(content)).SetVersion(page.Version + 1).Save(ctx)
			if updateErr != nil {
				return updateErr
			}
			page = updated
		}
		if err := s.replaceWikiLinks(ctx, userID, kbID, page.ID, links, "wikilink"); err != nil {
			return err
		}
	}
	_, err = s.rebuildWikiIndex(ctx, userID, kbID, kbName)
	return err
}

func (s *Service) rebuildWikiIndex(ctx context.Context, userID, kbID int64, kbName string) (*ent.KBWikiPage, error) {
	pages, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(), kbwikipage.KindNotIn("index"),
	).Order(ent.Asc(kbwikipage.FieldKind), ent.Asc(kbwikipage.FieldTitle)).All(ctx)
	if err != nil {
		return nil, err
	}
	groups := []struct{ kind, title string }{{"summary", "文档摘要"}, {"entity", "实体页面"}, {"concept", "概念页面"}}
	lines := []string{"# " + kbName + " Wiki", "", "由知识库文件及其证据分片自动编译。Wiki 用于阅读与导航，事实来源仍以原文件为准。"}
	counts := map[string]int{}
	keys := []string{}
	for _, group := range groups {
		lines = append(lines, "", "## "+group.title)
		found := false
		for _, page := range pages {
			if page.Kind != group.kind {
				continue
			}
			found = true
			counts[group.kind]++
			keys = append(keys, page.PageKey)
			lines = append(lines, fmt.Sprintf("- [[%s|%s]]：%s", page.PageKey, page.Title, wikiPageSummary(page, 140)))
		}
		if !found {
			lines = append(lines, "- 暂无")
		}
	}
	content := strings.Join(lines, "\n")
	summary := fmt.Sprintf("%d 篇文档摘要、%d 个实体页面、%d 个概念页面。", counts["summary"], counts["entity"], counts["concept"])
	page, err := s.upsertCompiledWikiPage(ctx, userID, kbID, "index", kbName+" Wiki", "index", summary, content, nil, true)
	if err != nil {
		return nil, err
	}
	frontmatter, _ := json.Marshal(map[string]any{"summaryPageCount": counts["summary"], "entityPageCount": counts["entity"], "conceptPageCount": counts["concept"], "generatedBy": "weknora-compatible-pipeline"})
	page, err = page.Update().SetFrontmatterJSON(string(frontmatter)).Save(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.replaceWikiLinks(ctx, userID, kbID, page.ID, keys, "index"); err != nil {
		return nil, err
	}
	return page, nil
}

func (s *Service) replaceWikiLinks(ctx context.Context, userID, kbID, fromPageID int64, keys []string, linkType string) error {
	if _, err := s.client.KBWikiLink.Delete().Where(kbwikilink.FromPageIDEQ(fromPageID)).Exec(ctx); err != nil {
		return err
	}
	seen := map[string]struct{}{}
	builders := make([]*ent.KBWikiLinkCreate, 0, len(keys))
	for _, key := range keys {
		key = normalizeWikiPageKey(key)
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		builders = append(builders, s.client.KBWikiLink.Create().SetUserID(userID).SetKnowledgeBaseID(kbID).SetFromPageID(fromPageID).SetToPageKey(key).SetLinkType(linkType))
	}
	if len(builders) == 0 {
		return nil
	}
	_, err := s.client.KBWikiLink.CreateBulk(builders...).Save(ctx)
	return err
}

type wikiLinkRef struct{ slug, text string }

type wikiForbiddenSpan struct{ start, end int }

func linkifyWikiContent(content string, refs []wikiLinkRef, self string) (string, bool) {
	if content == "" || len(refs) == 0 {
		return content, false
	}
	sort.SliceStable(refs, func(i, j int) bool {
		return utf8.RuneCountInString(refs[i].text) > utf8.RuneCountInString(refs[j].text)
	})
	forbidden, used := computeWikiForbiddenSpans(content)
	changed := false
	for _, ref := range refs {
		if ref.slug == self || strings.TrimSpace(ref.text) == "" {
			continue
		}
		if _, exists := used[ref.slug]; exists {
			continue
		}
		position := firstSafeWikiMatch(content, ref.text, forbidden)
		if position < 0 {
			continue
		}
		replacement := "[[" + ref.slug + "|" + ref.text + "]]"
		content = content[:position] + replacement + content[position+len(ref.text):]
		delta := len(replacement) - len(ref.text)
		forbidden = shiftWikiSpansAfter(forbidden, position, delta)
		forbidden = append(forbidden, wikiForbiddenSpan{start: position, end: position + len(replacement)})
		sort.Slice(forbidden, func(i, j int) bool { return forbidden[i].start < forbidden[j].start })
		used[ref.slug] = struct{}{}
		changed = true
	}
	return content, changed
}

func firstSafeWikiMatch(content, needle string, forbidden []wikiForbiddenSpan) int {
	if needle == "" {
		return -1
	}
	needsBoundary := wikiHasASCIIWordEdge(needle)
	for start := 0; start <= len(content)-len(needle); {
		rel := strings.Index(content[start:], needle)
		if rel < 0 {
			return -1
		}
		pos := start + rel
		lineStart := strings.LastIndex(content[:pos], "\n") + 1
		prefix := content[lineStart:pos]
		insideCode := strings.Count(content[:pos], "```")%2 == 1 || strings.Count(prefix, "`")%2 == 1
		insideWiki := strings.LastIndex(prefix, "[[") > strings.LastIndex(prefix, "]]")
		insideMarkdownLink := strings.LastIndex(prefix, "[") > strings.LastIndex(prefix, "]")
		if !insideCode && !insideWiki && !insideMarkdownLink && !wikiSpanOverlaps(forbidden, pos, pos+len(needle)) && (!needsBoundary || wikiWordBoundary(content, pos, pos+len(needle))) {
			return pos
		}
		start = pos + 1
	}
	return -1
}

func wikiWordBoundary(value string, start, end int) bool {
	if start > 0 {
		r, _ := utf8.DecodeLastRuneInString(value[:start])
		if r <= unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
			return false
		}
	}
	if end < len(value) {
		r, _ := utf8.DecodeRuneInString(value[end:])
		if r <= unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
			return false
		}
	}
	return true
}

var wikiLinkPattern = regexp.MustCompile(`\[\[([^\]|]+)(?:\|[^\]]+)?\]\]`)

func extractValidWikiLinks(content, self string, valid map[string]*ent.KBWikiPage) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, match := range wikiLinkPattern.FindAllStringSubmatch(content, -1) {
		key := normalizeWikiPageKey(match[1])
		if key == self || valid[key] == nil {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

// CleanupWikiAfterDocumentDelete 重新汇总仍有来源的页面并归档失去全部来源的页面。
func (s *Service) CleanupWikiAfterDocumentDelete(ctx context.Context, userID, kbID int64) (gin.H, error) {
	kbRow, err := s.GetOwned(ctx, userID, kbID)
	if err != nil {
		return nil, err
	}
	pages, err := s.client.KBWikiPage.Query().Where(kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(), kbwikipage.KindIn("entity", "concept")).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, page := range pages {
		count, countErr := s.client.KBWikiDocumentRef.Query().Where(kbwikidocumentref.PageIDEQ(page.ID)).Count(ctx)
		if countErr != nil {
			return nil, countErr
		}
		if count > 0 {
			if reduceErr := s.reduceWikiPageFromContributions(ctx, userID, kbID, page.PageKey); reduceErr != nil {
				return nil, reduceErr
			}
		}
	}
	if err := s.archiveUnreferencedWikiPages(ctx, userID, kbID); err != nil {
		return nil, err
	}
	if err := s.finalizeWiki(ctx, userID, kbID, kbRow.Name, nil, map[string]struct{}{}); err != nil {
		return nil, err
	}
	return gin.H{"rebuilt": true}, nil
}

// WikiGraph 返回 Wiki 页面双链，不表达实体关系知识图谱。
func (h *Handler) WikiGraph(c *gin.Context) {
	var req idRequest
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
	pages, err := h.svc.client.KBWikiPage.Query().Where(kbwikipage.UserIDEQ(u.ID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil()).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	links, err := h.svc.client.KBWikiLink.Query().Where(kbwikilink.UserIDEQ(u.ID), kbwikilink.KnowledgeBaseIDEQ(kbID)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	pageByID, valid, degree := map[int64]*ent.KBWikiPage{}, map[string]struct{}{}, map[string]int{}
	for _, page := range pages {
		pageByID[page.ID], valid[page.PageKey] = page, struct{}{}
	}
	edges := []gin.H{}
	seen := map[string]struct{}{}
	for _, link := range links {
		from := pageByID[link.FromPageID]
		if from == nil || from.PageKey == link.ToPageKey {
			continue
		}
		if _, exists := valid[link.ToPageKey]; !exists {
			continue
		}
		key := from.PageKey + "\x00" + link.ToPageKey
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		degree[from.PageKey]++
		degree[link.ToPageKey]++
		edges = append(edges, gin.H{"source": from.PageKey, "target": link.ToPageKey, "linkType": link.LinkType})
	}
	nodes := make([]gin.H, 0, len(pages))
	for _, page := range pages {
		nodes = append(nodes, gin.H{"pageKey": page.PageKey, "title": page.Title, "kind": page.Kind, "summary": page.Summary, "linkCount": degree[page.PageKey]})
	}
	response.OK(c, gin.H{"nodes": nodes, "edges": edges})
}

// runWikiCleanupJob 执行"文档删除后的 Wiki 重整"：重新汇总仍有来源的页面，
// 归档失去全部来源的页面，并重建索引。逐页 Reduce 会调用模型，因此只在后台跑。
func (s *Service) runWikiCleanupJob(ctx context.Context, job *ent.KBWikiIngestJob) error {
	startedAt := time.Now()
	s.log.Info("wiki cleanup started", zap.Int64("job_id", job.ID), zap.Int64("knowledge_base_id", job.KnowledgeBaseID))
	_, _ = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetPhase("reducing").Save(ctx)

	result, err := s.CleanupWikiAfterDocumentDelete(ctx, job.UserID, job.KnowledgeBaseID)
	if err != nil {
		return err
	}
	archived := 0
	if value, ok := result["archivedPages"].(int); ok {
		archived = value
	}
	finished := time.Now().UTC()
	_, err = s.client.KBWikiIngestJob.UpdateOneID(job.ID).SetStatus("completed").SetPhase("completed").
		SetFinishedAt(finished).ClearCurrentDocument().ClearError().Save(ctx)
	if err == nil {
		s.log.Info("wiki cleanup completed", zap.Int64("job_id", job.ID),
			zap.Int("archived_pages", archived), zap.Duration("duration", time.Since(startedAt)))
	}
	return err
}

// wikiClaimPhase 返回任务被领取时的初始阶段：重整任务不经过 Map，直接进入汇总。
func wikiClaimPhase(kind string) string {
	if kind == "cleanup" {
		return "reducing"
	}
	return "mapping"
}

// buildDocumentSummaryDigest 生成文件卡片用的摘要：以一句话概述开头，
// 再补上正文开头的散文，直到填满卡片可显示的篇幅。
// 只用一句话会让卡片显得空，只截正文又会丢掉那句精准的概述，两者拼接效果最好。
func buildDocumentSummaryDigest(summaryLine, summaryBody string) string {
	const limit = 300
	// 摘要里带着 [[slug|显示名]] 这种 Wiki 双链标记，卡片是纯文本展示，
	// 不还原成显示名的话方括号会原样显示出来。
	line := strings.TrimSpace(stripWikiLinkMarkup(summaryLine))
	body := strings.TrimSpace(stripWikiLinkMarkup(markdownToPlainText(summaryBody)))
	if line == "" {
		return truncateRunes(body, limit)
	}
	if len([]rune(line)) >= limit || body == "" {
		return truncateRunes(line, limit)
	}
	// 正文常以概述同样的内容开头，重复时只保留正文，避免卡片上同一句话出现两遍。
	if strings.HasPrefix(body, line) {
		return truncateRunes(body, limit)
	}
	return truncateRunes(line+" "+body, limit)
}

// stripWikiLinkMarkup 把 [[slug|显示名]] 还原成「显示名」、[[slug]] 还原成 slug 末段，
// 用于把 Wiki 正文转成给人看的纯文本。
func stripWikiLinkMarkup(value string) string {
	if !strings.Contains(value, "[[") {
		return value
	}
	return wikiLinkDisplayPattern.ReplaceAllStringFunc(value, func(match string) string {
		groups := wikiLinkDisplayPattern.FindStringSubmatch(match)
		if len(groups) < 3 {
			return match
		}
		if display := strings.TrimSpace(groups[2]); display != "" {
			return display
		}
		slug := strings.TrimSpace(groups[1])
		if index := strings.LastIndex(slug, "/"); index >= 0 {
			slug = slug[index+1:]
		}
		return strings.ReplaceAll(slug, "-", " ")
	})
}

var wikiLinkDisplayPattern = regexp.MustCompile(`\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`)
