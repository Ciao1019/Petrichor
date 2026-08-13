package kb

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunk"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/vector"
)

// DocumentChunkHit 是知识库文件的可定位检索结果。
type DocumentChunkHit struct {
	Type              string  `json:"type"`
	KnowledgeBaseID   string  `json:"knowledgeBaseId"`
	KnowledgeBaseName string  `json:"knowledgeBaseName,omitempty"`
	DocumentID        string  `json:"documentId"`
	DocumentTitle     string  `json:"documentTitle"`
	FileName          string  `json:"fileName"`
	FileType          string  `json:"fileType"`
	ChunkID           string  `json:"chunkId"`
	ChunkIndex        int     `json:"chunkIndex"`
	Page              *int    `json:"page"`
	Locator           *string `json:"locator"`
	// Text 是交给模型的正文：开启父子分块时这里是父块内容，上下文更完整。
	Text string `json:"text"`
	// MatchedText 是真正命中的子块正文，父子分块下与 Text 不同，便于定位和高亮。
	MatchedText string `json:"matchedText,omitempty"`
	// MatchedQuestion 是把这一片召回来的 AI 生成问题，sources 含 question 时才有。
	MatchedQuestion string   `json:"matchedQuestion,omitempty"`
	Score           float64  `json:"score"`
	Sources         []string `json:"sources"`
}

type documentCandidate struct {
	chunk  *ent.KBDocumentChunk
	doc    *ent.KBDocument
	kbName string
	score  float64
	// matchedQuestion 是把这一片召回来的那条 AI 生成问题，便于解释召回原因。
	matchedQuestion string
	sources         map[string]struct{}
}

// EmbedKnowledgeBaseDocumentChunks 为知识库文件分片写入 embedding。
func (s *Service) EmbedKnowledgeBaseDocumentChunks(ctx context.Context, userID, knowledgeBaseID int64, documentID *int64, rebuild bool) (int, *vector.DocumentEmbeddingStatus, error) {
	if s.sql == nil {
		return 0, nil, response.BadRequest("向量生成需要 PostgreSQL 数据库")
	}
	kbRow, err := s.GetOwned(ctx, userID, knowledgeBaseID)
	if err != nil {
		return 0, nil, err
	}
	if documentID != nil {
		exists, err := s.client.KBDocument.Query().Where(
			kbdocument.IDEQ(*documentID), kbdocument.UserIDEQ(userID), kbdocument.KnowledgeBaseIDEQ(knowledgeBaseID),
		).Exist(ctx)
		if err != nil || !exists {
			if err == nil {
				err = response.NotFound("文件不存在")
			}
			return 0, nil, err
		}
	}
	if rebuild {
		if err := vector.ClearDocumentEmbeddings(ctx, s.sql, userID, knowledgeBaseID, documentID); err != nil {
			return 0, nil, err
		}
	}
	pending, err := vector.LoadPendingDocumentChunks(ctx, s.sql, userID, knowledgeBaseID, documentID)
	if err != nil {
		return 0, nil, err
	}
	if len(pending) == 0 {
		status, err := vector.GetDocumentEmbeddingStatus(ctx, s.sql, userID, knowledgeBaseID)
		return 0, status, err
	}
	cfg, err := ai.ResolveEmbeddingConfig(ctx, s.client, userID, kbRow.EmbeddingModelID)
	if err != nil {
		return 0, nil, err
	}
	gen := ai.NewGeneration(s.cfg)
	embedded := 0
	for offset := 0; offset < len(pending); offset += vector.DocumentEmbedBatchSize {
		end := min(offset+vector.DocumentEmbedBatchSize, len(pending))
		batch := pending[offset:end]
		texts := make([]string, len(batch))
		for index, row := range batch {
			texts[index] = vector.BuildDocumentEmbedText(row.Title, row.Text, row.ContextHeader)
		}
		vecs, err := gen.Embed(ctx, cfg, texts)
		if err != nil {
			return embedded, nil, err
		}
		for index, row := range batch {
			if index >= len(vecs) || len(vecs[index]) != vector.Dimensions {
				return embedded, nil, response.BadRequest(fmt.Sprintf("Embedding 维度必须为 %d", vector.Dimensions))
			}
			if err := vector.UpdateDocumentChunkEmbedding(ctx, s.sql, row.ID, vecs[index]); err != nil {
				return embedded, nil, err
			}
			embedded++
		}
	}
	status, err := vector.GetDocumentEmbeddingStatus(ctx, s.sql, userID, knowledgeBaseID)
	return embedded, status, err
}

func (s *Service) GetDocumentEmbeddingStatus(ctx context.Context, userID, knowledgeBaseID int64) (*vector.DocumentEmbeddingStatus, error) {
	if err := s.assertKBOwner(ctx, userID, knowledgeBaseID); err != nil {
		return nil, err
	}
	return vector.GetDocumentEmbeddingStatus(ctx, s.sql, userID, knowledgeBaseID)
}

// SearchDocumentChunks 执行关键词 + 向量召回，并按知识库绑定模型做 Rerank。
// 模型调用失败时保留关键词结果，保证知识库始终可检索。
func (s *Service) SearchDocumentChunks(ctx context.Context, userID int64, knowledgeBaseID *int64, query string, limit int) ([]DocumentChunkHit, error) {
	keyword := strings.TrimSpace(query)
	if keyword == "" {
		return []DocumentChunkHit{}, nil
	}
	limit = max(1, min(limit, 20))
	if knowledgeBaseID != nil {
		if err := s.assertKBOwner(ctx, userID, *knowledgeBaseID); err != nil {
			return nil, err
		}
	}
	candidates := map[int64]*documentCandidate{}
	keywordLimit := min(limit*4, 80)
	// 父块不参与匹配，它只在子块命中后被回填为上下文。
	q := s.client.KBDocumentChunk.Query().Where(
		kbdocumentchunk.UserIDEQ(userID), kbdocumentchunk.TextContainsFold(keyword),
		kbdocumentchunk.ChunkTypeNEQ("parent_text"),
	)
	if knowledgeBaseID != nil {
		q = q.Where(kbdocumentchunk.KnowledgeBaseIDEQ(*knowledgeBaseID))
	}
	rows, err := q.Order(ent.Desc(kbdocumentchunk.FieldID)).Limit(keywordLimit).All(ctx)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		candidates[row.ID] = &documentCandidate{chunk: row, score: keywordDocumentScore(row.Text, keyword), sources: map[string]struct{}{"keyword": {}}}
	}

	var scopeKB *ent.KnowledgeBase
	if knowledgeBaseID != nil {
		scopeKB, err = s.client.KnowledgeBase.Query().Where(
			knowledgebase.IDEQ(*knowledgeBaseID), knowledgebase.UserIDEQ(userID),
		).Only(ctx)
		if err != nil {
			return nil, err
		}
	}
	if s.sql != nil {
		var embeddingID *int64
		if scopeKB != nil {
			embeddingID = scopeKB.EmbeddingModelID
		}
		if cfg, resolveErr := ai.ResolveEmbeddingConfig(ctx, s.client, userID, embeddingID); resolveErr == nil && cfg != nil {
			if vecs, embedErr := ai.NewGeneration(s.cfg).Embed(ctx, cfg, []string{keyword}); embedErr == nil && len(vecs) == 1 && len(vecs[0]) == vector.Dimensions {
				vectorLimit := min(limit*4, 80)
				// 正文向量召回。
				distances := map[int64]float64{}
				if semantic, searchErr := vector.SemanticSearchDocumentChunks(ctx, s.sql, userID, knowledgeBaseID, vecs[0], vectorLimit); searchErr == nil {
					for _, hit := range semantic {
						distances[hit.ChunkID] = hit.Distance
					}
				}
				// 问题向量召回：命中的是 AI 生成的问题，但回指的是它所属的分片。
				// 用户提问的措辞往往和正文差很远，这条通道就是为这种情况准备的。
				questionDistances := map[int64]float64{}
				matchedQuestions := map[int64]string{}
				if hits, searchErr := vector.SemanticSearchChunkQuestions(ctx, s.sql, userID, knowledgeBaseID, vecs[0], vectorLimit); searchErr == nil {
					for _, hit := range hits {
						// 同一分片可能挂多条问题，只保留最近的那条。
						if existing, ok := questionDistances[hit.ChunkID]; ok && existing <= hit.Distance {
							continue
						}
						questionDistances[hit.ChunkID] = hit.Distance
						matchedQuestions[hit.ChunkID] = hit.Question
					}
				}
				ids := make([]int64, 0, len(distances)+len(questionDistances))
				for id := range distances {
					ids = append(ids, id)
				}
				for id := range questionDistances {
					if _, ok := distances[id]; !ok {
						ids = append(ids, id)
					}
				}
				if len(ids) > 0 {
					chunks, loadErr := s.client.KBDocumentChunk.Query().Where(kbdocumentchunk.IDIn(ids...)).All(ctx)
					if loadErr != nil {
						return nil, loadErr
					}
					for _, row := range chunks {
						candidate := candidates[row.ID]
						if candidate == nil {
							candidate = &documentCandidate{chunk: row, sources: map[string]struct{}{}}
							candidates[row.ID] = candidate
						}
						if distance, ok := distances[row.ID]; ok {
							candidate.score += similarityFromDistance(distance) * 12
							candidate.sources["semantic"] = struct{}{}
						}
						if distance, ok := questionDistances[row.ID]; ok {
							// 权重略低于正文向量：问题是派生内容，命中它是强信号但不是原文证据。
							candidate.score += similarityFromDistance(distance) * 10
							candidate.sources["question"] = struct{}{}
							candidate.matchedQuestion = matchedQuestions[row.ID]
						}
					}
				}
			}
		}
	}

	ordered := make([]*documentCandidate, 0, len(candidates))
	documentIDs := map[int64]struct{}{}
	for _, candidate := range candidates {
		ordered = append(ordered, candidate)
		documentIDs[candidate.chunk.DocumentID] = struct{}{}
	}
	if len(ordered) == 0 {
		return []DocumentChunkHit{}, nil
	}
	ids := make([]int64, 0, len(documentIDs))
	for id := range documentIDs {
		ids = append(ids, id)
	}
	documents, err := s.client.KBDocument.Query().Where(
		kbdocument.IDIn(ids...), kbdocument.UserIDEQ(userID),
		kbdocument.StatusIn("ready", "partial"),
	).All(ctx)
	if err != nil {
		return nil, err
	}
	docByID := make(map[int64]*ent.KBDocument, len(documents))
	kbIDs := map[int64]struct{}{}
	for _, doc := range documents {
		docByID[doc.ID] = doc
		kbIDs[doc.KnowledgeBaseID] = struct{}{}
	}
	kbNames := make(map[int64]string, len(kbIDs))
	if len(kbIDs) > 0 {
		values := make([]int64, 0, len(kbIDs))
		for id := range kbIDs {
			values = append(values, id)
		}
		kbRows, loadErr := s.client.KnowledgeBase.Query().Where(knowledgebase.IDIn(values...), knowledgebase.UserIDEQ(userID)).All(ctx)
		if loadErr != nil {
			return nil, loadErr
		}
		for _, row := range kbRows {
			kbNames[row.ID] = row.Name
		}
	}
	filtered := ordered[:0]
	for _, candidate := range ordered {
		if doc := docByID[candidate.chunk.DocumentID]; doc != nil {
			candidate.doc, candidate.kbName = doc, kbNames[doc.KnowledgeBaseID]
			filtered = append(filtered, candidate)
		}
	}
	ordered = filtered
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].score > ordered[j].score })
	if len(ordered) > min(limit*4, 60) {
		ordered = ordered[:min(limit*4, 60)]
	}

	var rerankID *int64
	if scopeKB != nil {
		rerankID = scopeKB.RerankModelID
	}
	if rerankCfg, resolveErr := ai.ResolveRerankConfig(ctx, s.client, userID, rerankID); resolveErr == nil && rerankCfg != nil && len(ordered) > 1 {
		texts := make([]string, len(ordered))
		for index, candidate := range ordered {
			contextHeader := ""
			if candidate.chunk.ContextHeader != nil {
				contextHeader = *candidate.chunk.ContextHeader
			}
			texts[index] = vector.BuildDocumentEmbedText(candidate.doc.Title, candidate.chunk.Text, contextHeader)
		}
		if ranked, rerankErr := ai.NewGeneration(s.cfg).Rerank(ctx, rerankCfg, keyword, texts, limit); rerankErr == nil {
			reordered := make([]*documentCandidate, 0, len(ranked))
			for _, rank := range ranked {
				candidate := ordered[rank.Index]
				candidate.score = rank.Score
				candidate.sources["rerank"] = struct{}{}
				reordered = append(reordered, candidate)
			}
			ordered = reordered
		}
	}
	if len(ordered) > limit {
		ordered = ordered[:limit]
	}
	parentText, err := s.loadParentChunkTexts(ctx, ordered)
	if err != nil {
		return nil, err
	}
	out := make([]DocumentChunkHit, 0, len(ordered))
	for _, candidate := range ordered {
		sources := make([]string, 0, len(candidate.sources))
		for source := range candidate.sources {
			sources = append(sources, source)
		}
		sort.Strings(sources)
		// 命中的是子块，但回填给模型的是父块正文——这正是父子分块的意义：
		// 用小块精准命中，用大块提供完整上下文。
		text, matched := candidate.chunk.Text, ""
		if candidate.chunk.ParentChunkIndex != nil {
			if parent, ok := parentText[parentChunkKey{candidate.chunk.DocumentID, *candidate.chunk.ParentChunkIndex}]; ok && parent != "" {
				text, matched = parent, candidate.chunk.Text
			}
		}
		out = append(out, DocumentChunkHit{
			Type: "document_chunk", KnowledgeBaseID: fmt.Sprintf("%d", candidate.doc.KnowledgeBaseID), KnowledgeBaseName: candidate.kbName,
			DocumentID: fmt.Sprintf("%d", candidate.doc.ID), DocumentTitle: candidate.doc.Title,
			FileName: candidate.doc.FileName, FileType: candidate.doc.FileType,
			ChunkID: fmt.Sprintf("%d", candidate.chunk.ID), ChunkIndex: candidate.chunk.ChunkIndex,
			Page: candidate.chunk.Page, Locator: candidate.chunk.Locator, Text: text, MatchedText: matched,
			MatchedQuestion: candidate.matchedQuestion, Score: candidate.score, Sources: sources,
		})
	}
	return out, nil
}

// similarityFromDistance 把余弦距离换算成 [0,1] 的相似度分。
func similarityFromDistance(distance float64) float64 {
	score := 1 - distance
	if score < 0 {
		return 0
	}
	return score
}

func keywordDocumentScore(text, query string) float64 {
	normalized, needle := strings.ToLower(text), strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return 0
	}
	score := float64(strings.Count(normalized, needle) * 8)
	for _, term := range tokenizeSearchQuery(query) {
		score += float64(strings.Count(normalized, term))
	}
	return score
}

func (s *Service) LoadDocumentChunkForAgent(ctx context.Context, userID, knowledgeBaseID, documentID int64, chunkIndex int, window int) (map[string]any, error) {
	if window < 0 {
		window = 0
	}
	window = min(window, 5)
	doc, err := s.client.KBDocument.Query().Where(
		kbdocument.IDEQ(documentID), kbdocument.UserIDEQ(userID), kbdocument.KnowledgeBaseIDEQ(knowledgeBaseID),
	).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("文件不存在")
		}
		return nil, err
	}
	chunks, err := s.client.KBDocumentChunk.Query().Where(
		kbdocumentchunk.DocumentIDEQ(documentID), kbdocumentchunk.UserIDEQ(userID),
		kbdocumentchunk.ChunkIndexGTE(max(0, chunkIndex-window)), kbdocumentchunk.ChunkIndexLTE(chunkIndex+window),
	).Order(ent.Asc(kbdocumentchunk.FieldChunkIndex)).All(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, len(chunks))
	for _, chunk := range chunks {
		items = append(items, map[string]any{"id": fmt.Sprintf("%d", chunk.ID), "chunkIndex": chunk.ChunkIndex, "page": chunk.Page, "locator": chunk.Locator, "text": chunk.Text})
	}
	return map[string]any{
		"kind": "document_chunk", "knowledgeBaseId": fmt.Sprintf("%d", knowledgeBaseID),
		"documentId": fmt.Sprintf("%d", doc.ID), "documentTitle": doc.Title, "fileName": doc.FileName,
		"fileType": doc.FileType, "targetChunkIndex": chunkIndex, "chunks": items,
		"href": fmt.Sprintf("/dashboard/knowledge/%d/documents/%d?chunk=%d", knowledgeBaseID, documentID, chunkIndex),
	}, nil
}
