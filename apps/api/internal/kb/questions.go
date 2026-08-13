package kb

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunk"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunkquestion"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/vector"
)

const (
	// 每个批次处理的分片数。按批而不是按片建子 span，
	// 大文档才不会在时间线上炸出几百行。
	questionBatchSize = 8
	// 同时在跑的批次数，控制对模型服务的并发压力。
	questionBatchConcurrency = 2
	// 送进模型的单片正文上限，超出截断。
	questionChunkMaxChars = 4000
	// 前后文各取多少字符，帮助模型理解这一片在讲什么。
	questionContextChars = 600
)

// BuildQuestionGenerationPrompt 组装问题生成提示词。
//
// 目标是 Doc2Query：为分片生成"用户真会这么问、而且这一片能答上"的问题，
// 每条问题独立向量化后作为额外的召回入口。
func BuildQuestionGenerationPrompt(
	docTitle, content, prevContent, nextContent string, questionCount int, customInstructions string,
) string {
	hasContext := strings.TrimSpace(prevContent) != "" || strings.TrimSpace(nextContent) != ""

	var builder strings.Builder
	builder.WriteString("你是一个面向检索优化的问题生成助手。\n")
	builder.WriteString("请为 <main_content> 生成它最能回答的问题——也就是用户真正需要这段信息时会去搜的问题。\n")
	if hasContext {
		// 只有真的给了前后文才提这个标签，否则模型会去找一段并不存在的内容。
		builder.WriteString("<surrounding_context> 只用来帮你理解 <main_content>，不要为它生成问题。\n")
	}
	builder.WriteString("\n")

	if hasContext {
		builder.WriteString("<surrounding_context>\n")
		if strings.TrimSpace(prevContent) != "" {
			builder.WriteString("<preceding_content>\n" + prevContent + "\n</preceding_content>\n")
		}
		if strings.TrimSpace(nextContent) != "" {
			builder.WriteString("<following_content>\n" + nextContent + "\n</following_content>\n")
		}
		builder.WriteString("</surrounding_context>\n\n")
	}

	builder.WriteString("<main_content>\n")
	builder.WriteString("文档名称：" + docTitle + "\n\n")
	builder.WriteString(content + "\n")
	builder.WriteString("</main_content>\n\n")

	builder.WriteString("## 质量要求\n")
	builder.WriteString("- 只针对这段内容能完整或充分回答的问题，不要抓一笔带过的细节。\n")
	builder.WriteString("- 优先覆盖主题、核心概念、操作方法与结论，不要出考试式的琐碎问答。\n")
	builder.WriteString("- 贴近真实检索意图：如何……、什么是……、为什么……、……的最佳实践是什么。\n")
	builder.WriteString("- 每条问题都要自洽：不用「它」「这个」「该文档」之类的指代，直接写出具体名称。\n")
	builder.WriteString("- 每条问题简洁清楚，控制在 40 个字以内。\n\n")

	builder.WriteString("## 不要生成\n")
	builder.WriteString("- 只被顺带提及的次要细节。\n")
	builder.WriteString("- 从原文抠一个词或一个数字就能答完的问题。\n")
	builder.WriteString("- 宽泛到这段内容根本答不完整的问题。\n\n")

	builder.WriteString(fmt.Sprintf("## 输出\n生成 %d 个问题，每行一个，不要编号、不要前缀、不要任何解释。\n", questionCount))
	builder.WriteString("使用与正文相同的语言。\n")

	if strings.TrimSpace(customInstructions) != "" {
		builder.WriteString("\n## 额外要求（不得违反上面的输出格式）\n")
		builder.WriteString(strings.TrimSpace(customInstructions) + "\n")
	}
	return builder.String()
}

// ParseGeneratedQuestions 从模型输出里提取问题列表：逐行清理编号/项目符号，
// 丢掉过短的噪声行，最多取 limit 条。
func ParseGeneratedQuestions(raw string, limit int) []string {
	if limit <= 0 {
		return nil
	}
	out := make([]string, 0, limit)
	seen := map[string]struct{}{}
	for _, line := range strings.Split(raw, "\n") {
		value := strings.TrimSpace(line)
		if value == "" {
			continue
		}
		value = strings.TrimSpace(strings.TrimLeft(value, "0123456789.、-*)（）() "))
		if len([]rune(value)) < 5 {
			continue
		}
		if len([]rune(value)) > 200 {
			value = string([]rune(value)[:200])
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
		if len(out) >= limit {
			break
		}
	}
	return out
}

// runQuestionGenerationStage 为文档的文本分片生成问题并落库、向量化。
// 返回实际写入的问题条数。这一段失败不影响文档可用性，只体现在时间线上。
func (s *Service) runQuestionGenerationStage(
	ctx context.Context, tracker *spanTracker, parent *pipelineSpan,
	userID int64, doc *ent.KBDocument, kbRow *ent.KnowledgeBase, config QuestionGenerationConfig,
) int {
	span := tracker.BeginSubSpan(ctx, parent, "postprocess.question", SpanKindSubSpan, map[string]any{
		"questionCount": config.QuestionCount,
	})

	// 多模态识别出的 image 分片同样是可召回内容，也值得配问题；
	// 只有 parent_text 例外——它不参与匹配，给它生成问题没有意义。
	chunks, err := s.client.KBDocumentChunk.Query().Where(
		kbdocumentchunk.DocumentIDEQ(doc.ID), kbdocumentchunk.ChunkTypeIn("text", "image"),
	).Order(ent.Asc(kbdocumentchunk.FieldChunkIndex)).All(ctx)
	if err != nil {
		tracker.FailSpan(ctx, span, "QUESTION_LOAD_CHUNKS_FAILED", err)
		return 0
	}
	if len(chunks) == 0 {
		tracker.SkipSpan(ctx, span, "没有可生成问题的文本分片")
		return 0
	}
	modelCfg, err := ai.ResolveChatConfig(ctx, s.client, userID)
	if err != nil {
		tracker.SkipSpan(ctx, span, "未配置对话模型")
		return 0
	}

	// 重跑时先清掉旧问题，避免同一分片上叠加多轮生成的结果。
	if _, err := s.client.KBDocumentChunkQuestion.Delete().
		Where(kbdocumentchunkquestion.DocumentIDEQ(doc.ID)).Exec(ctx); err != nil {
		tracker.FailSpan(ctx, span, "QUESTION_CLEANUP_FAILED", err)
		return 0
	}

	batches := make([][]*ent.KBDocumentChunk, 0, len(chunks)/questionBatchSize+1)
	for offset := 0; offset < len(chunks); offset += questionBatchSize {
		batches = append(batches, chunks[offset:minInt(offset+questionBatchSize, len(chunks))])
	}

	gen := ai.NewGeneration(s.cfg)
	var mu sync.Mutex
	written := 0

	queue := make(chan int)
	var workers sync.WaitGroup
	for i := 0; i < minInt(questionBatchConcurrency, len(batches)); i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for batchIndex := range queue {
				batch := batches[batchIndex]
				batchSpan := tracker.BeginSubSpan(ctx, span,
					fmt.Sprintf("postprocess.question.batch[%d]", batchIndex), SpanKindGeneration,
					map[string]any{"chunks": len(batch)})
				count, batchErr := s.generateQuestionsForBatch(ctx, gen, modelCfg, userID, doc, chunks, batch, config)
				mu.Lock()
				written += count
				mu.Unlock()
				if batchErr != nil {
					tracker.FailSpan(ctx, batchSpan, "QUESTION_GENERATION_FAILED", batchErr)
					continue
				}
				tracker.EndSpan(ctx, batchSpan, map[string]any{"questions": count})
			}
		}()
	}
	for index := range batches {
		queue <- index
	}
	close(queue)
	workers.Wait()

	if written == 0 {
		tracker.EndSpan(ctx, span, map[string]any{"questions": 0})
		return 0
	}
	embedded, embedErr := s.embedDocumentQuestions(ctx, userID, doc, kbRow)
	if embedErr != nil {
		// 问题已经落库，只是还没有向量：关键词召回不受影响，可以稍后补齐。
		s.log.Warn("问题向量化失败", zap.Int64("document_id", doc.ID), zap.Error(embedErr))
		tracker.FailSpan(ctx, span, "QUESTION_EMBEDDING_FAILED", embedErr)
		return written
	}
	tracker.EndSpan(ctx, span, map[string]any{"questions": written, "embedded": embedded})
	return written
}

// generateQuestionsForBatch 为一批分片逐片生成问题并写库。
func (s *Service) generateQuestionsForBatch(
	ctx context.Context, gen *ai.Generation, modelCfg *ent.AIModelConfig,
	userID int64, doc *ent.KBDocument, all []*ent.KBDocumentChunk, batch []*ent.KBDocumentChunk,
	config QuestionGenerationConfig,
) (int, error) {
	positions := make(map[int64]int, len(all))
	for index, chunk := range all {
		positions[chunk.ID] = index
	}
	written := 0
	for _, chunk := range batch {
		content := chunk.Text
		if runes := []rune(content); len(runes) > questionChunkMaxChars {
			content = string(runes[:questionChunkMaxChars])
		}
		prev, next := "", ""
		if position, ok := positions[chunk.ID]; ok {
			if position > 0 {
				prev = tailRunes(all[position-1].Text, questionContextChars)
			}
			if position+1 < len(all) {
				next = headRunes(all[position+1].Text, questionContextChars)
			}
		}
		prompt := BuildQuestionGenerationPrompt(doc.Title, content, prev, next, config.QuestionCount, config.CustomInstructions)
		result, err := gen.Chat(ctx, modelCfg, []ai.ChatMessage{{Role: "user", Content: prompt}})
		if err != nil {
			return written, err
		}
		questions := ParseGeneratedQuestions(result.Content, config.QuestionCount)
		for _, question := range questions {
			err := s.client.KBDocumentChunkQuestion.Create().
				SetUserID(userID).SetKnowledgeBaseID(doc.KnowledgeBaseID).SetDocumentID(doc.ID).
				SetChunkID(chunk.ID).SetQuestion(question).Exec(ctx)
			if err != nil {
				return written, err
			}
			written++
		}
	}
	return written, nil
}

// embedDocumentQuestions 给文档下还没有向量的问题批量补向量。
func (s *Service) embedDocumentQuestions(
	ctx context.Context, userID int64, doc *ent.KBDocument, kbRow *ent.KnowledgeBase,
) (int, error) {
	if s.sql == nil {
		return 0, fmt.Errorf("问题向量化需要 PostgreSQL 数据库")
	}
	pending, err := vector.LoadPendingChunkQuestions(ctx, s.sql, userID, doc.ID)
	if err != nil {
		return 0, err
	}
	if len(pending) == 0 {
		return 0, nil
	}
	cfg, err := ai.ResolveEmbeddingConfig(ctx, s.client, userID, kbRow.EmbeddingModelID)
	if err != nil {
		return 0, err
	}
	gen := ai.NewGeneration(s.cfg)
	embedded := 0
	for offset := 0; offset < len(pending); offset += vector.DocumentEmbedBatchSize {
		end := minInt(offset+vector.DocumentEmbedBatchSize, len(pending))
		batch := pending[offset:end]
		texts := make([]string, len(batch))
		for index, row := range batch {
			// 问题向量只编码问题本身加文档标题：把正文也拼进来会把它拉回"正文相似"，
			// 失去问题作为独立召回入口的意义。
			texts[index] = vector.BuildDocumentEmbedText(row.Title, row.Question)
		}
		vecs, err := gen.Embed(ctx, cfg, texts)
		if err != nil {
			return embedded, err
		}
		for index, row := range batch {
			if index >= len(vecs) || len(vecs[index]) != vector.Dimensions {
				return embedded, fmt.Errorf("Embedding 维度必须为 %d", vector.Dimensions)
			}
			if err := vector.UpdateChunkQuestionEmbedding(ctx, s.sql, row.ID, vecs[index]); err != nil {
				return embedded, err
			}
			embedded++
		}
	}
	return embedded, nil
}

// chunkQuestionContext 是操作单个分片问题时需要的上下文：分片本身、
// 它所属的文档与知识库，以及文档上保存的问题生成配置。
type chunkQuestionContext struct {
	chunk  *ent.KBDocumentChunk
	doc    *ent.KBDocument
	kb     *ent.KnowledgeBase
	config QuestionGenerationConfig
}

func (s *Service) loadChunkQuestionContext(ctx context.Context, userID, chunkID int64) (*chunkQuestionContext, error) {
	chunk, err := s.client.KBDocumentChunk.Query().Where(
		kbdocumentchunk.IDEQ(chunkID), kbdocumentchunk.UserIDEQ(userID),
	).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("分片不存在")
		}
		return nil, err
	}
	if chunk.ChunkType == "parent_text" {
		return nil, response.BadRequest("父块不参与召回，不需要生成问题")
	}
	doc, err := s.client.KBDocument.Query().Where(
		kbdocument.IDEQ(chunk.DocumentID), kbdocument.UserIDEQ(userID),
	).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("文件不存在")
		}
		return nil, err
	}
	kbRow, err := s.GetOwned(ctx, userID, doc.KnowledgeBaseID)
	if err != nil {
		return nil, err
	}
	return &chunkQuestionContext{
		chunk: chunk, doc: doc, kb: kbRow,
		config: decodeDocumentParseConfig(doc.ParseConfigJSON).QuestionGeneration,
	}, nil
}

// AddChunkQuestion 手工补一条问题并立即向量化，让它马上能参与召回。
func (s *Service) AddChunkQuestion(ctx context.Context, userID, chunkID int64, question string) ([]ChunkQuestion, error) {
	question = strings.TrimSpace(question)
	if question == "" {
		return nil, response.BadRequest("问题内容不能为空")
	}
	if runes := []rune(question); len(runes) > 200 {
		question = string(runes[:200])
	}
	target, err := s.loadChunkQuestionContext(ctx, userID, chunkID)
	if err != nil {
		return nil, err
	}
	exists, err := s.client.KBDocumentChunkQuestion.Query().Where(
		kbdocumentchunkquestion.ChunkIDEQ(chunkID), kbdocumentchunkquestion.QuestionEQ(question),
	).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, response.BadRequest("这条问题已经存在")
	}
	err = s.client.KBDocumentChunkQuestion.Create().
		SetUserID(userID).SetKnowledgeBaseID(target.doc.KnowledgeBaseID).SetDocumentID(target.doc.ID).
		SetChunkID(chunkID).SetQuestion(question).Exec(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := s.embedDocumentQuestions(ctx, userID, target.doc, target.kb); err != nil {
		// 问题已经落库，只是暂时没有向量：留给「补齐向量」或下次重解析处理。
		s.log.Warn("新增问题向量化失败", zap.Int64("chunk_id", chunkID), zap.Error(err))
	}
	return s.listChunkQuestions(ctx, chunkID)
}

// DeleteChunkQuestion 删除一条问题，对应的向量随行一起消失。
func (s *Service) DeleteChunkQuestion(ctx context.Context, userID, questionID int64) (int64, []ChunkQuestion, error) {
	row, err := s.client.KBDocumentChunkQuestion.Query().Where(
		kbdocumentchunkquestion.IDEQ(questionID), kbdocumentchunkquestion.UserIDEQ(userID),
	).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return 0, nil, response.NotFound("问题不存在")
		}
		return 0, nil, err
	}
	if err := s.client.KBDocumentChunkQuestion.DeleteOneID(questionID).Exec(ctx); err != nil {
		return 0, nil, err
	}
	questions, err := s.listChunkQuestions(ctx, row.ChunkID)
	return row.ChunkID, questions, err
}

// RegenerateChunkQuestions 只为这一个分片重新生成问题，替换掉它原有的问题与向量。
// 用于「这一片的问题不对」的场景，不需要把整份文档重解析一遍。
func (s *Service) RegenerateChunkQuestions(ctx context.Context, userID, chunkID int64) ([]ChunkQuestion, error) {
	target, err := s.loadChunkQuestionContext(ctx, userID, chunkID)
	if err != nil {
		return nil, err
	}
	modelCfg, err := ai.ResolveChatConfig(ctx, s.client, userID)
	if err != nil {
		return nil, err
	}
	// 沿用文档上保存的问题数量；从没开过问题生成的文档用默认值。
	count := target.config.QuestionCount
	if count <= 0 {
		count = 3
	}

	prev, next := s.neighbourChunkTexts(ctx, target.chunk)
	content := target.chunk.Text
	if runes := []rune(content); len(runes) > questionChunkMaxChars {
		content = string(runes[:questionChunkMaxChars])
	}
	prompt := BuildQuestionGenerationPrompt(target.doc.Title, content, prev, next, count, target.config.CustomInstructions)
	result, err := ai.NewGeneration(s.cfg).Chat(ctx, modelCfg, []ai.ChatMessage{{Role: "user", Content: prompt}})
	if err != nil {
		return nil, err
	}
	questions := ParseGeneratedQuestions(result.Content, count)
	if len(questions) == 0 {
		return nil, response.BadRequest("模型没有返回可用的问题，请重试")
	}

	if _, err := s.client.KBDocumentChunkQuestion.Delete().
		Where(kbdocumentchunkquestion.ChunkIDEQ(chunkID)).Exec(ctx); err != nil {
		return nil, err
	}
	for _, question := range questions {
		err := s.client.KBDocumentChunkQuestion.Create().
			SetUserID(userID).SetKnowledgeBaseID(target.doc.KnowledgeBaseID).SetDocumentID(target.doc.ID).
			SetChunkID(chunkID).SetQuestion(question).Exec(ctx)
		if err != nil {
			return nil, err
		}
	}
	if _, err := s.embedDocumentQuestions(ctx, userID, target.doc, target.kb); err != nil {
		s.log.Warn("重新生成的问题向量化失败", zap.Int64("chunk_id", chunkID), zap.Error(err))
	}
	return s.listChunkQuestions(ctx, chunkID)
}

// neighbourChunkTexts 取相邻分片的片段作为前后文，帮助模型理解这一片在讲什么。
func (s *Service) neighbourChunkTexts(ctx context.Context, chunk *ent.KBDocumentChunk) (prev string, next string) {
	siblings, err := s.client.KBDocumentChunk.Query().Where(
		kbdocumentchunk.DocumentIDEQ(chunk.DocumentID),
		kbdocumentchunk.ChunkTypeEQ(chunk.ChunkType),
		kbdocumentchunk.ChunkIndexGTE(chunk.ChunkIndex-1),
		kbdocumentchunk.ChunkIndexLTE(chunk.ChunkIndex+1),
	).Order(ent.Asc(kbdocumentchunk.FieldChunkIndex)).All(ctx)
	if err != nil {
		return "", ""
	}
	for _, sibling := range siblings {
		switch sibling.ChunkIndex {
		case chunk.ChunkIndex - 1:
			prev = tailRunes(sibling.Text, questionContextChars)
		case chunk.ChunkIndex + 1:
			next = headRunes(sibling.Text, questionContextChars)
		}
	}
	return prev, next
}

// ChunkQuestion 是返回给前端的一条问题。带 id 是为了能单独删除某一条。
type ChunkQuestion struct {
	ID       string `json:"id"`
	Question string `json:"question"`
}

func (s *Service) listChunkQuestions(ctx context.Context, chunkID int64) ([]ChunkQuestion, error) {
	rows, err := s.client.KBDocumentChunkQuestion.Query().
		Where(kbdocumentchunkquestion.ChunkIDEQ(chunkID)).
		Order(ent.Asc(kbdocumentchunkquestion.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]ChunkQuestion, 0, len(rows))
	for _, row := range rows {
		out = append(out, ChunkQuestion{ID: fmt.Sprintf("%d", row.ID), Question: row.Question})
	}
	return out, nil
}

// LoadChunkQuestions 按分片 id 取回已生成的问题，用于文档详情展示。
func (s *Service) LoadChunkQuestions(ctx context.Context, documentID int64) (map[int64][]ChunkQuestion, error) {
	rows, err := s.client.KBDocumentChunkQuestion.Query().
		Where(kbdocumentchunkquestion.DocumentIDEQ(documentID)).
		Order(ent.Asc(kbdocumentchunkquestion.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[int64][]ChunkQuestion, len(rows))
	for _, row := range rows {
		out[row.ChunkID] = append(out[row.ChunkID], ChunkQuestion{ID: fmt.Sprintf("%d", row.ID), Question: row.Question})
	}
	return out, nil
}

func headRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func tailRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[len(runes)-limit:])
}
