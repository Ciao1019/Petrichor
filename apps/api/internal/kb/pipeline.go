package kb

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunk"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentspan"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikiingestjob"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/upload"
)

// pipelineInput 是启动一次解析所需的、来自上传请求的一次性输入。
// 页面图片由浏览器栅格化后直传对象存储，这里只拿到对象键。
type pipelineInput struct {
	// ClientText / ClientSegments 是浏览器解析出的正文，服务端解析不可用时兜底。
	ClientText     string
	ClientSegments []kbTextSegmentInput
	// PageImages 是需要多模态识别的整页图片，按页号升序。
	PageImages []documentPageImage
}

type documentPageImage struct {
	PageNo   int    `json:"pageNo"`
	ImageKey string `json:"imageKey"`
}

// 单个文档内并行识别的页数上限。本地 Ollama 受 OLLAMA_NUM_PARALLEL 限制，
// 再高也不会更快，反而更容易触发上游限流。
const multimodalPageConcurrency = 3

// startDocumentPipeline 把解析放到后台执行，HTTP 请求立即返回。
// 上传大 PDF 时多模态与问题生成动辄几分钟，挂在请求上既会超时也看不到进度。
func (s *Service) startDocumentPipeline(userID, documentID int64, attempt int, input pipelineInput) {
	go func() {
		// 后台任务与发起它的请求生命周期无关，用独立 context 并留足超时。
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
		defer cancel()
		s.runDocumentPipeline(ctx, userID, documentID, attempt, input)
	}()
}

// runDocumentPipeline 依次跑完文档处理阶段，在文档 ready 后可靠提交可选的 Wiki 后台阶段。
//
// 阶段划分与依赖：
//
//	文档解析 → 分块 → 向量化 ┐
//	              └→ 多模态识别 ┴→ 后处理 → Wiki（可选异步）
//
// 多模态不依赖向量化：它产出的是独立的图片分片，跑完再补一次向量化。
func (s *Service) runDocumentPipeline(ctx context.Context, userID, documentID int64, attempt int, input pipelineInput) {
	doc, err := s.client.KBDocument.Query().Where(
		kbdocument.IDEQ(documentID), kbdocument.UserIDEQ(userID),
	).Only(ctx)
	if err != nil {
		s.log.Warn("解析流水线找不到文档", zap.Int64("document_id", documentID), zap.Error(err))
		return
	}
	kbRow, err := s.GetOwned(ctx, userID, doc.KnowledgeBaseID)
	if err != nil {
		s.failDocument(ctx, documentID, "知识库不存在或无权访问")
		return
	}
	config := decodeDocumentParseConfig(doc.ParseConfigJSON)
	// 本次调用没带图片时用文档上存着的那份，重新解析才不至于把扫描件跑成空文档。
	pageImages := input.PageImages
	if len(pageImages) == 0 {
		pageImages = config.PageImages
	}
	input.PageImages = pageImages

	tracker := s.newSpanTracker(ctx, userID, documentID, attempt, map[string]any{
		"fileName":    doc.FileName,
		"fileType":    doc.FileType,
		"parseEngine": config.ParseEngine,
		"multimodal":  config.Multimodal.Enabled,
		"questions":   config.QuestionGeneration.Enabled,
		"pageImages":  len(pageImages),
	})

	if _, err := s.client.KBDocument.UpdateOneID(documentID).SetStatus("processing").ClearError().Save(ctx); err != nil {
		s.log.Warn("更新文档状态失败", zap.Int64("document_id", documentID), zap.Error(err))
	}

	// 致命失败：这一段标红，依赖它的下游标成 cancelled（而不是永远 pending），整次尝试结束。
	failed := func(stage *pipelineSpan, code string, err error) {
		tracker.FailSpan(ctx, stage, code, err)
		tracker.CancelDownstream(ctx, stage.name, stage.name+" 失败")
		tracker.FinishRoot(ctx, true, code, err, nil)
		s.failDocument(ctx, documentID, err.Error())
	}

	// ---- 阶段 1：文档解析 ----
	extractSpan := tracker.BeginStage(ctx, StageExtract, map[string]any{
		"engine": config.ParseEngine, "fileType": doc.FileType,
	})
	extracted, extractErr := s.resolvePipelineText(ctx, doc, config, input)
	if extractErr != nil {
		failed(extractSpan, "EXTRACT_FAILED", extractErr)
		return
	}
	if strings.TrimSpace(extracted.Text) == "" && len(pageImages) == 0 {
		failed(extractSpan, "EMPTY_CONTENT", fmt.Errorf("没有抽取到可用正文；若是扫描件，请在解析配置里开启图像处理"))
		return
	}
	charCount := len([]rune(extracted.Text))
	extractOutput := map[string]any{
		"source": extracted.Source, "charCount": charCount, "segments": len(extracted.Segments),
	}
	// 抽取器报的错即使没让流水线停下来，也要留在时间线上——
	// 否则"为什么这份文档只有多模态识别的内容"这种问题没法回答。
	if extracted.Warning != "" {
		extractOutput["warning"] = extracted.Warning
	}
	tracker.EndSpan(ctx, extractSpan, extractOutput)

	// ---- 阶段 2：分块 ----
	chunkSpan := tracker.BeginStage(ctx, StageChunking, map[string]any{
		"strategy": kbRow.ChunkStrategy, "chunkSize": kbRow.ChunkSize,
	})
	settings := chunkingSettingsWithOverride(kbRow, config.Chunking)
	chunkRows := chunkDocumentText(extracted.Text, settings, extracted.Segments)
	if len(chunkRows) > 8000 {
		failed(chunkSpan, "TOO_MANY_CHUNKS", fmt.Errorf("分片数量超出上限（%d），请调大分块大小", len(chunkRows)))
		return
	}
	if err := s.replaceDocumentChunks(ctx, userID, doc.KnowledgeBaseID, documentID, chunkRows, extracted, charCount); err != nil {
		failed(chunkSpan, "CHUNK_WRITE_FAILED", err)
		return
	}
	retrievable := countRetrievableChunks(chunkRows)
	tracker.EndSpan(ctx, chunkSpan, map[string]any{
		"chunks": len(chunkRows), "retrievable": retrievable,
		"strategy": settings.Strategy, "chunkSize": settings.ChunkSize,
		"parentChild": settings.EnableParentChild,
	})

	// ---- 阶段 3：向量化 ----
	embedSpan := tracker.BeginStage(ctx, StageEmbedding, map[string]any{"pending": retrievable})
	if retrievable == 0 {
		tracker.SkipSpan(ctx, embedSpan, "没有可向量化的文本分片")
	} else if embedded, _, embedErr := s.EmbedKnowledgeBaseDocumentChunks(ctx, userID, doc.KnowledgeBaseID, &documentID, false); embedErr != nil {
		// 向量化失败不终止流水线：分片已经能被关键词召回，向量可以稍后补齐。
		tracker.FailSpan(ctx, embedSpan, "EMBEDDING_FAILED", embedErr)
	} else {
		tracker.EndSpan(ctx, embedSpan, map[string]any{"embedded": embedded})
	}

	// ---- 阶段 4：多模态识别 ----
	multimodalSpan := tracker.BeginStage(ctx, StageMultimodal, map[string]any{"pages": len(pageImages)})
	imageChunks := 0
	switch {
	case !config.Multimodal.Enabled:
		tracker.SkipSpan(ctx, multimodalSpan, "未开启图像处理")
	case len(pageImages) == 0:
		tracker.SkipSpan(ctx, multimodalSpan, "没有需要识别的图片内容")
	default:
		count, mmErr := s.runMultimodalStage(ctx, tracker, multimodalSpan, userID, doc, config, chunkRows, pageImages)
		imageChunks = count
		if mmErr != nil {
			// 部分页失败不回滚已识别的页：能用的内容先入库，失败的页在时间线上单独可见。
			tracker.FailSpan(ctx, multimodalSpan, "MULTIMODAL_FAILED", mmErr)
		} else {
			tracker.EndSpan(ctx, multimodalSpan, map[string]any{"imageChunks": count})
		}
		if count > 0 {
			// 图片分片是新写入的，需要再补一次向量。
			if _, _, err := s.EmbedKnowledgeBaseDocumentChunks(ctx, userID, doc.KnowledgeBaseID, &documentID, false); err != nil {
				s.log.Warn("图片分片向量化失败", zap.Int64("document_id", documentID), zap.Error(err))
			}
		}
	}

	// ---- 阶段 5：后处理 ----
	postSpan := tracker.BeginStage(ctx, StagePostFinish, nil)
	questionCount := 0
	if config.QuestionGeneration.Enabled {
		questionCount = s.runQuestionGenerationStage(ctx, tracker, postSpan, userID, doc, kbRow, config.QuestionGeneration)
	} else {
		skip := tracker.BeginSubSpan(ctx, postSpan, "postprocess.question", SpanKindSubSpan, nil)
		tracker.SkipSpan(ctx, skip, "未开启 AI 问题生成")
	}
	s.runSummaryStage(ctx, tracker, postSpan, userID, doc, extracted.Text)
	tracker.EndSpan(ctx, postSpan, map[string]any{"questions": questionCount})

	total := retrievable + imageChunks
	if _, err := s.client.KBDocument.UpdateOneID(documentID).
		SetStatus("ready").SetChunkCount(total).ClearError().Save(ctx); err != nil {
		s.log.Warn("回写文档状态失败", zap.Int64("document_id", documentID), zap.Error(err))
	}

	// ---- 阶段 6：Wiki 构建 ----
	// 自动 Wiki 必须由服务端在文档真正 ready 后入队，不能依赖上传页面再发一次请求：
	// 页面刷新、网络中断或前端持有旧设置都不应导致任务丢失。
	var wikiJobID string
	if kbRow.WikiEnabled {
		job, queueErr := s.QueueKnowledgeBaseDocumentsWiki(
			ctx, userID, doc.KnowledgeBaseID, []string{fmt.Sprintf("%d", documentID)}, false,
		)
		if queueErr != nil {
			wikiSpan := tracker.BeginStage(ctx, StageWiki, map[string]any{"automatic": true})
			tracker.FailSpan(ctx, wikiSpan, "WIKI_QUEUE_FAILED", queueErr)
			s.log.Warn("自动 Wiki 入队失败", zap.Int64("document_id", documentID), zap.Error(queueErr))
		} else {
			wikiJobID = fmt.Sprintf("%d", job.ID)
		}
	} else {
		wikiSpan := tracker.BeginStage(ctx, StageWiki, map[string]any{"automatic": false})
		tracker.SkipSpan(ctx, wikiSpan, "知识库未开启自动 Wiki")
	}
	tracker.FinishRoot(ctx, false, "", nil, map[string]any{
		"chunks": total, "questions": questionCount, "imageChunks": imageChunks, "wikiJobId": wikiJobID,
	})
}

// pipelineText 是文档解析阶段的产物。
type pipelineText struct {
	Text     string
	Segments []kbTextSegmentInput
	// Source 记录正文最终来自哪里，写进 span 便于排查"为什么解析结果和预期不一样"。
	Source string
	// Warning 是没有中断流水线、但值得记在时间线上的抽取问题（如 sidecar 不可用）。
	Warning string
}

// resolvePipelineText 按解析引擎决定正文从哪来。
//   - scan  ：整份按扫描件处理，正文完全交给多模态阶段产出
//   - local ：只用服务端本地抽取，抽不到就报错，不悄悄退回浏览器结果
//   - auto  ：服务端优先 → 浏览器正文 → 交给多模态
//
// pageImages 非空意味着这份文档还有多模态这条后路，此时抽不出文本不是致命错误：
// 扫描件本来就没有文本层，本地抽取失败恰恰说明该交给多模态了。
func (s *Service) resolvePipelineText(
	ctx context.Context, doc *ent.KBDocument, config DocumentParseConfig, input pipelineInput,
) (pipelineText, error) {
	pageImages := len(input.PageImages) > 0
	if config.ParseEngine == ParseEngineScan {
		return pipelineText{Source: "scan"}, nil
	}
	parsed, err := s.extractDocumentServerSide(ctx, doc.FileType, doc.ObjectKey)
	if err == nil && strings.TrimSpace(parsed.Text) != "" {
		return pipelineText{Text: parsed.Text, Segments: parsed.Segments, Source: "server"}, nil
	}
	warning := ""
	if err != nil {
		warning = "服务端抽取未生效：" + err.Error()
	}
	if config.ParseEngine == ParseEngineLocal {
		if err == nil {
			err = fmt.Errorf("本地抽取未得到正文")
		}
		if pageImages {
			return pipelineText{Source: "scan", Warning: warning}, nil
		}
		return pipelineText{}, err
	}
	if strings.TrimSpace(input.ClientText) != "" {
		return pipelineText{Text: input.ClientText, Segments: input.ClientSegments, Source: "client", Warning: warning}, nil
	}
	if pageImages {
		return pipelineText{Source: "scan", Warning: warning}, nil
	}
	if err != nil {
		return pipelineText{}, err
	}
	return pipelineText{Source: "empty"}, nil
}

// replaceDocumentChunks 用新的分块结果整体替换文档分片，并回写正文与统计。
func (s *Service) replaceDocumentChunks(
	ctx context.Context, userID, kbID, documentID int64,
	rows []kbChunkRow, extracted pipelineText, charCount int,
) error {
	tx, err := s.client.Tx(ctx)
	if err != nil {
		return err
	}
	if _, err := tx.KBDocumentChunk.Delete().Where(kbdocumentchunk.DocumentIDEQ(documentID)).Exec(ctx); err != nil {
		_ = tx.Rollback()
		return err
	}
	update := tx.KBDocument.UpdateOneID(documentID).
		SetCharCount(charCount).SetChunkCount(countRetrievableChunks(rows)).SetExtractedText(extracted.Text)
	if len(extracted.Segments) > 0 {
		if raw, marshalErr := json.Marshal(extracted.Segments); marshalErr == nil {
			update.SetSegmentsJSON(string(raw))
		}
	}
	if _, err := update.Save(ctx); err != nil {
		_ = tx.Rollback()
		return err
	}
	if err := insertKBDocumentChunks(ctx, tx, userID, kbID, documentID, rows); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// runMultimodalStage 逐页调用多模态模型，把识别结果写成独立的 image 分片。
//
// 图片分片接在文本分片编号之后，chunk_type 为 image，同样参与召回；
// 这样扫描件即使一个字都抽不出来，也能通过识别文本被检索到。
func (s *Service) runMultimodalStage(
	ctx context.Context, tracker *spanTracker, parent *pipelineSpan,
	userID int64, doc *ent.KBDocument, config DocumentParseConfig,
	textRows []kbChunkRow, pages []documentPageImage,
) (int, error) {
	var modelID *int64
	if config.Multimodal.ModelConfigID != nil {
		if value, err := parsePositiveID(*config.Multimodal.ModelConfigID, "modelConfigId"); err == nil {
			modelID = &value
		}
	}
	modelCfg, err := ai.ResolveVisionConfig(ctx, s.client, userID, modelID)
	if err != nil {
		return 0, err
	}
	gen := ai.NewGeneration(s.cfg)

	ordered := append([]documentPageImage(nil), pages...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].PageNo < ordered[j].PageNo })

	type pageResult struct {
		pageNo   int
		markdown string
	}
	results := make([]pageResult, len(ordered))
	failures := make([]error, len(ordered))

	queue := make(chan int)
	var workers sync.WaitGroup
	for i := 0; i < minInt(multimodalPageConcurrency, len(ordered)); i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range queue {
				page := ordered[index]
				span := tracker.BeginSubSpan(ctx, parent, fmt.Sprintf("multimodal.page[%d]", page.PageNo),
					SpanKindGeneration, map[string]any{"pageNo": page.PageNo})
				imageBytes, fetchErr := upload.FetchObjectBytes(ctx, s.cfg, page.ImageKey)
				if fetchErr != nil {
					failures[index] = fmt.Errorf("第 %d 页图片读取失败：%w", page.PageNo, fetchErr)
					tracker.FailSpan(ctx, span, "IMAGE_FETCH_FAILED", fetchErr)
					continue
				}
				markdown, visionErr := ai.CallVision(ctx, gen, modelCfg, toImageDataURL(page.ImageKey, imageBytes))
				if visionErr != nil {
					failures[index] = fmt.Errorf("第 %d 页识别失败：%w", page.PageNo, visionErr)
					tracker.FailSpan(ctx, span, "VISION_FAILED", visionErr)
					continue
				}
				results[index] = pageResult{pageNo: page.PageNo, markdown: markdown}
				tracker.EndSpan(ctx, span, map[string]any{"charCount": len([]rune(markdown))})
			}
		}()
	}
	for index := range ordered {
		queue <- index
	}
	close(queue)
	workers.Wait()

	nextIndex := 0
	for _, row := range textRows {
		if row.ChunkIndex >= nextIndex {
			nextIndex = row.ChunkIndex + 1
		}
	}
	written := 0
	for _, result := range results {
		if strings.TrimSpace(result.markdown) == "" {
			continue
		}
		pageNo := result.pageNo
		locator := fmt.Sprintf("p.%d", pageNo)
		builder := s.client.KBDocumentChunk.Create().
			SetUserID(userID).SetKnowledgeBaseID(doc.KnowledgeBaseID).SetDocumentID(doc.ID).
			SetChunkIndex(nextIndex).SetChunkType("image").SetText(result.markdown).
			SetCharCount(len([]rune(result.markdown))).SetTokenEstimate(estimateChunkTokens(result.markdown)).
			SetPage(pageNo).SetLocator(locator)
		if err := builder.Exec(ctx); err != nil {
			return written, err
		}
		nextIndex++
		written++
	}

	for _, failure := range failures {
		if failure != nil {
			return written, failure
		}
	}
	return written, nil
}

// runSummaryStage 在后处理阶段补一句文档摘要，让文档卡片有内容可显示。
// 摘要失败不影响解析结论，只把这一段标成失败。
func (s *Service) runSummaryStage(
	ctx context.Context, tracker *spanTracker, parent *pipelineSpan,
	userID int64, doc *ent.KBDocument, text string,
) {
	span := tracker.BeginSubSpan(ctx, parent, "postprocess.summary", SpanKindGeneration, nil)
	if strings.TrimSpace(text) == "" {
		tracker.SkipSpan(ctx, span, "没有正文可供摘要")
		return
	}
	modelCfg, err := ai.ResolveChatConfig(ctx, s.client, userID)
	if err != nil {
		tracker.SkipSpan(ctx, span, "未配置对话模型")
		return
	}
	result, err := ai.NewGeneration(s.cfg).Chat(ctx, modelCfg, []ai.ChatMessage{
		{Role: "system", Content: BuildArticleSummarySystemPrompt()},
		{Role: "user", Content: BuildArticleSummaryUserMessage(doc.Title, text)},
	})
	if err != nil {
		tracker.FailSpan(ctx, span, "SUMMARY_FAILED", err)
		return
	}
	summary, err := NormalizeArticleSummaryModelOutput(result.Content)
	if err != nil {
		tracker.FailSpan(ctx, span, "SUMMARY_INVALID", err)
		return
	}
	if _, err := s.client.KBDocument.UpdateOneID(doc.ID).SetSummary(summary).Save(ctx); err != nil {
		tracker.FailSpan(ctx, span, "SUMMARY_WRITE_FAILED", err)
		return
	}
	tracker.EndSpan(ctx, span, map[string]any{"charCount": len([]rune(summary))})
}

func (s *Service) failDocument(ctx context.Context, documentID int64, message string) {
	if _, err := s.client.KBDocument.UpdateOneID(documentID).
		SetStatus("failed").SetError(truncateSpanText(message, 500)).Save(ctx); err != nil {
		s.log.Warn("标记文档解析失败时出错", zap.Int64("document_id", documentID), zap.Error(err))
	}
}

// LoadDocumentSpans 读取某次尝试的 span 树。attempt 传 0 表示最新一次。
func (s *Service) LoadDocumentSpans(ctx context.Context, userID, documentID int64, attempt int) (map[string]any, error) {
	doc, err := s.client.KBDocument.Query().Where(
		kbdocument.IDEQ(documentID), kbdocument.UserIDEQ(userID),
	).Only(ctx)
	if err != nil {
		return nil, err
	}
	current := attempt
	if current <= 0 {
		current = doc.ParseAttempt
	}
	rows := []*ent.KBDocumentSpan{}
	if current > 0 {
		rows, err = s.client.KBDocumentSpan.Query().Where(
			kbdocumentspan.DocumentIDEQ(documentID), kbdocumentspan.AttemptEQ(current),
		).Order(ent.Asc(kbdocumentspan.FieldID)).All(ctx)
		if err != nil {
			return nil, err
		}
	}
	tree, currentStage, failure := buildSpanTree(rows, doc.Status)
	rootStartedAt := doc.CreatedAt
	for _, row := range rows {
		if row.Kind == SpanKindRoot && row.StartedAt != nil {
			rootStartedAt = *row.StartedAt
			break
		}
	}
	wikiJob, err := s.latestWikiJobForDocument(ctx, userID, doc.KnowledgeBaseID, documentID, rootStartedAt)
	if err != nil {
		return nil, err
	}
	currentStage, failure = attachWikiStage(tree, doc.Status, wikiJob, currentStage, failure)
	payload := map[string]any{
		"documentId":    fmt.Sprintf("%d", doc.ID),
		"status":        doc.Status,
		"attempt":       current,
		"latestAttempt": doc.ParseAttempt,
		"currentStage":  currentStage,
		"parseConfig":   decodeDocumentParseConfig(doc.ParseConfigJSON),
		"trace":         tree,
	}
	if failure != nil {
		payload["lastError"] = map[string]any{
			"stage": failure.Name, "code": failure.ErrorCode, "message": failure.ErrorMessage,
		}
	} else if doc.Status == "failed" && doc.Error != nil {
		payload["lastError"] = map[string]any{
			"stage": "document_processing", "code": "UNKNOWN", "message": *doc.Error,
		}
	}
	return payload, nil
}

// latestWikiJobForDocument 找到本次解析开始后创建或合并过、且与该文档关联的最新 Wiki 任务。
// document_ids_json 是历史既有字段；在不做数据库结构变更的前提下，这也能把手动任务
// 和自动任务统一映射回文档流水线，并兼容已经在运行的旧任务。
func (s *Service) latestWikiJobForDocument(
	ctx context.Context, userID, knowledgeBaseID, documentID int64, since time.Time,
) (*ent.KBWikiIngestJob, error) {
	jobs, err := s.client.KBWikiIngestJob.Query().Where(
		kbwikiingestjob.UserIDEQ(userID),
		kbwikiingestjob.KnowledgeBaseIDEQ(knowledgeBaseID),
		kbwikiingestjob.KindEQ("ingest"),
		kbwikiingestjob.UpdatedAtGTE(since),
	).Order(ent.Desc(kbwikiingestjob.FieldUpdatedAt), ent.Desc(kbwikiingestjob.FieldID)).Limit(200).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, job := range jobs {
		if wikiJobContainsAllDocuments(job, []int64{documentID}) {
			return job, nil
		}
	}
	return nil, nil
}

func attachWikiStage(
	root *SpanNode, documentStatus string, job *ent.KBWikiIngestJob, currentStage string, failure *SpanNode,
) (string, *SpanNode) {
	if root == nil {
		return currentStage, failure
	}
	index := -1
	for childIndex, child := range root.Children {
		if child.Kind == SpanKindStage && child.Name == StageWiki {
			index = childIndex
			break
		}
	}
	if index < 0 {
		return currentStage, failure
	}
	if job == nil {
		stage := root.Children[index]
		if !stage.Placeholder {
			return currentStage, failure
		}
		switch documentStatus {
		case "ready":
			stage.Status = SpanStatusSkipped
			stage.Output = map[string]any{"reason": "本次解析没有关联 Wiki 构建任务"}
		case "failed":
			stage.Status = SpanStatusCancelled
			stage.Output = map[string]any{"reason": "文档处理失败，未构建 Wiki"}
		default:
			stage.Status = SpanStatusPending
		}
		return currentStage, failure
	}

	stage := wikiJobSpanNode(job, root.SpanID)
	root.Children[index] = stage
	if stage.Status == SpanStatusPending || stage.Status == SpanStatusRunning {
		currentStage = StageWiki
	} else if currentStage == StageWiki {
		currentStage = ""
	}
	if stage.Status == SpanStatusFailed {
		failure = stage
	}
	return currentStage, failure
}

func wikiJobSpanNode(job *ent.KBWikiIngestJob, parentSpanID string) *SpanNode {
	status := SpanStatusPending
	switch job.Status {
	case "running":
		status = SpanStatusRunning
	case "completed":
		status = SpanStatusDone
	case "failed":
		status = SpanStatusFailed
	}
	startedAt := job.CreatedAt
	if job.StartedAt != nil {
		startedAt = *job.StartedAt
	}
	var finishedAt *string
	duration := int64(0)
	if job.FinishedAt != nil {
		finishedAt = formatTimePtr(job.FinishedAt)
		duration = job.FinishedAt.Sub(startedAt).Milliseconds()
	}
	warnings := []string{}
	_ = json.Unmarshal([]byte(job.WarningsJSON), &warnings)
	node := &SpanNode{
		SpanID:       fmt.Sprintf("wiki-job-%d", job.ID),
		ParentSpanID: parentSpanID,
		Name:         StageWiki,
		Kind:         SpanKindStage,
		Status:       status,
		StartedAt:    formatTimePtr(&startedAt),
		FinishedAt:   finishedAt,
		DurationMs:   duration,
		Input: map[string]any{
			"jobId": fmt.Sprintf("%d", job.ID), "automatic": !job.ForceRebuild,
			"forceRebuild": job.ForceRebuild, "totalDocuments": job.TotalDocuments,
		},
		Output: map[string]any{
			"phase": job.Phase, "processedDocuments": job.ProcessedDocuments,
			"totalDocuments": job.TotalDocuments, "processedPages": job.ProcessedPages,
			"totalPages": job.TotalPages, "currentDocument": job.CurrentDocument, "warnings": warnings,
		},
	}
	if job.Error != nil {
		node.ErrorCode = "WIKI_BUILD_FAILED"
		node.ErrorMessage = *job.Error
	}
	return node
}
