// wiki3.go 对照 article-knowledge-index.ts：分片索引状态、chunk/list 与 wiki/embedding/run。
package kb

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// ArticleKnowledgeIndexVersion 对应 ARTICLE_KNOWLEDGE_INDEX_VERSION。
const ArticleKnowledgeIndexVersion = 1

// ChunkAlgorithmVersion 对应 CHUNK_ALGORITHM_VERSION（切片算法版本，存量按 0 处理）。
const ChunkAlgorithmVersion = 2

// ArticleKnowledgeBuildVersion 对应 ARTICLE_KNOWLEDGE_BUILD_VERSION。
const ArticleKnowledgeBuildVersion = 4

const (
	indexBatchSize    = 64
	maxEmbedPerPhase  = 2000
	maxEmbedTextChars = 4000
)

// embeddingProfile 对应 EmbeddingProfile；version 固定 EMBEDDING_VERSION=1。
type embeddingProfile struct {
	modelRefID int64
	model      string
	dimensions *int32
	version    int32
}

// loadEmbeddingProfileOrNull 只读解析 EMBEDDING 绑定；未配置/失效返回 nil。
func loadEmbeddingProfileOrNull(q execQuerier, userID int64) (*embeddingProfile, error) {
	ctx := context.Background()
	var (
		modelRefID int64
		modelID    string
		dimensions *int32
	)
	err := q.QueryRow(ctx,
		`SELECT m.id, m.model_id, m.dimensions FROM petrichor_ai_binding b
		 JOIN petrichor_ai_model m ON m.id = b.model_ref_id AND m.enabled = true AND m.kind = 'EMBEDDING'
		 JOIN petrichor_ai_provider p ON p.id = m.provider_id AND p.enabled = true
		 WHERE b.user_id = $1 AND b.purpose = 'EMBEDDING' LIMIT 1`, userID).
		Scan(&modelRefID, &modelID, &dimensions)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	return &embeddingProfile{modelRefID: modelRefID, model: modelID, dimensions: dimensions, version: 1}, nil
}

type indexPhaseStatus struct {
	Total    int64 `json:"total"`
	Embedded int64 `json:"embedded"`
	Pending  int64 `json:"pending"`
	Failed   int64 `json:"failed"`
}

// getArticleIndexStatus 对应 getKnowledgeBaseArticleIndexStatus（Postgres 路径）。
func getArticleIndexStatus(q execQuerier, userID, knowledgeBaseID int64) (map[string]any, error) {
	if _, err := assertKnowledgeBaseOwner(q, userID, knowledgeBaseID); err != nil {
		return nil, err
	}
	profile, err := loadEmbeddingProfileOrNull(q, userID)
	if err != nil {
		return nil, err
	}

	countableCond := "false"
	args := []any{userID, knowledgeBaseID}
	if profile != nil && profile.dimensions != nil {
		countableCond = `(embedding is not null and embedding_status = 'ready'
			and embedding_model = $3 and embedding_dimensions = $4 and embedding_version = $5)`
		args = append(args, profile.model, *profile.dimensions, profile.version)
	}
	rows, err := q.Query(context.Background(),
		`SELECT source_type,
		   count(*)::bigint AS total,
		   count(*) filter (where `+countableCond+`)::bigint AS embedded,
		   count(*) filter (where embedding_status = 'failed')::bigint AS failed
		 FROM petrichor_kb_article_chunk_index
		 WHERE user_id = $1 AND knowledge_base_id = $2
		 GROUP BY source_type`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	chunk := indexPhaseStatus{}
	question := indexPhaseStatus{}
	for rows.Next() {
		var sourceType string
		var total, embedded, failed int64
		if err := rows.Scan(&sourceType, &total, &embedded, &failed); err != nil {
			return nil, err
		}
		switch sourceType {
		case "chunk":
			chunk = indexPhaseStatus{Total: total, Embedded: embedded, Failed: failed}
		case "question":
			question = indexPhaseStatus{Total: total, Embedded: embedded, Failed: failed}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	setPending := func(p *indexPhaseStatus) {
		pending := p.Total - p.Embedded
		if pending < 0 {
			pending = 0
		}
		p.Pending = pending
	}
	setPending(&chunk)
	setPending(&question)
	total := chunk.Total + question.Total
	embedded := chunk.Embedded + question.Embedded
	overallPending := total - embedded
	if overallPending < 0 {
		overallPending = 0
	}
	var modelOut any
	var dimsOut any
	var versionOut any
	if profile != nil {
		modelOut = profile.model
		versionOut = profile.version
		dimsOut = profile.dimensions // *int32 序列化为 null 或数字
	}
	return map[string]any{
		"supported":  true,
		"total":      total,
		"embedded":   embedded,
		"pending":    overallPending,
		"failed":     chunk.Failed + question.Failed,
		"chunk":      chunk,
		"question":   question,
		"model":      modelOut,
		"dimensions": dimsOut,
		"version":    versionOut,
	}, nil
}

// ===== 端点：knowledge/chunk/list =====

// ArticleKnowledgeChunkList 已持久化的文章切片与推荐问题（纯查询）。
func ArticleKnowledgeChunkList(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}
		article, err := queryArticle(q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article
			 WHERE id = $1 AND user_id = $2 AND knowledge_base_id = $3 LIMIT 1`,
			articleID, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		if article == nil {
			return nil, notFoundErr("文章不存在")
		}
		chunkRows, err := queryChunks(q,
			`SELECT `+chunkColumns+` FROM petrichor_kb_article_chunk
			 WHERE user_id = $1 AND knowledge_base_id = $2 AND article_id = $3 ORDER BY position ASC`,
			user.ID, kbID, article.ID)
		if err != nil {
			return nil, err
		}
		sourcePage, err := loadWikiPage(q, user.ID, kbID, buildArticleWikiSourcePageKey(article.ID))
		if err != nil {
			return nil, err
		}

		builtHash := ""
		if sourcePage != nil {
			builtHash = readFrontmatterSourceHash(sourcePage.FrontmatterJson)
		}
		chunkAlgorithmVersion := int64(0)
		if sourcePage != nil {
			chunkAlgorithmVersion = frontmatterNumber(sourcePage.FrontmatterJson, "chunkAlgorithmVersion")
		}
		currentHash := sha256Hex(article.Title + "\n" + article.ContentMd)

		builtAt := ""
		var builtAtTime = zeroTime()
		for i := range chunkRows {
			if builtAtTime.IsZero() || chunkRows[i].UpdatedAt.After(builtAtTime) {
				builtAtTime = chunkRows[i].UpdatedAt
				builtAt = iso(chunkRows[i].UpdatedAt)
			}
		}

		chunks := make([]map[string]any, 0, len(chunkRows))
		questionCount := 0
		for i := range chunkRows {
			row := &chunkRows[i]
			questions := parseStringArray(&row.RecommendedQuestionsJson)
			questionCount += len(questions)
			chunks = append(chunks, map[string]any{
				"id":                   strconv.FormatInt(row.ID, 10),
				"chunkKey":             row.ChunkKey,
				"position":             row.Position,
				"heading":              row.Heading,
				"contentMd":            row.ContentMd,
				"charCount":            len([]rune(row.ContentMd)),
				"contentHash":          row.ContentHash,
				"headingPath":          parseStringArray(&row.HeadingPathJson),
				"recommendedQuestions": questions,
				"updatedAt":            iso(row.UpdatedAt),
			})
		}
		stale := false
		if len(chunks) > 0 {
			stale = (builtHash != "" && builtHash != currentHash) || chunkAlgorithmVersion < ChunkAlgorithmVersion
		}
		var builtAtOut any
		if builtAt != "" {
			builtAtOut = builtAt
		}
		return map[string]any{
			"articleId":                    strconv.FormatInt(article.ID, 10),
			"knowledgeBaseId":              strconv.FormatInt(kbID, 10),
			"articleTitle":                 article.Title,
			"built":                        len(chunks) > 0,
			"stale":                        stale,
			"chunkAlgorithmVersion":        chunkAlgorithmVersion,
			"currentChunkAlgorithmVersion": int64(ChunkAlgorithmVersion),
			"builtAt":                      builtAtOut,
			"chunkCount":                   len(chunks),
			"questionCount":                questionCount,
			"chunks":                       chunks,
		}, nil
	})
}

func queryChunks(q execQuerier, sql string, args ...any) ([]ChunkRow, error) {
	rows, err := q.Query(context.Background(), sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChunkRow
	for rows.Next() {
		var r ChunkRow
		if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ArticleID, &r.ChunkKey,
			&r.Position, &r.Heading, &r.ContentMd, &r.ContentHash, &r.HeadingPathJson,
			&r.RecommendedQuestionsJson, &r.CreatedAt, &r.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func zeroTime() (t time.Time) { return }

// readFrontmatterSourceHash 的 JSON 解析版已在 node.go 提供；此处补数值字段读取。
func frontmatterNumber(raw *string, field string) int64 {
	obj := parseJSONObject(raw)
	if obj == nil {
		return 0
	}
	if f, ok := obj[field].(float64); ok {
		return int64(f)
	}
	return 0
}

// ===== 端点：wiki/embedding/run =====

type pendingIndexRow struct {
	id            int64
	embeddingText string
}

// loadPendingIndexRows 待重算行：模型/维度/版本不一致或尚未就绪。
func loadPendingIndexRows(q execQuerier, userID, knowledgeBaseID int64, sourceType string, profile *embeddingProfile) ([]pendingIndexRow, bool, error) {
	rows, err := q.Query(context.Background(),
		`SELECT id, embedding_text FROM petrichor_kb_article_chunk_index
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND source_type = $3 AND id IN (
		   SELECT id FROM petrichor_kb_article_chunk_index
		   WHERE user_id = $1 AND knowledge_base_id = $2 AND source_type = $3
		     AND (embedding IS NULL OR embedding_status <> 'ready'
		       OR embedding_model IS DISTINCT FROM $4
		       OR embedding_dimensions IS DISTINCT FROM $5
		       OR embedding_version IS DISTINCT FROM $6)
		 )
		 ORDER BY article_id ASC, chunk_id ASC, source_position ASC
		 LIMIT $7`,
		userID, knowledgeBaseID, sourceType, profile.model, nullableInt(profile.dimensions),
		profile.version, maxEmbedPerPhase+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var out []pendingIndexRow
	for rows.Next() {
		var r pendingIndexRow
		if err := rows.Scan(&r.id, &r.embeddingText); err != nil {
			return nil, false, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := false
	if len(out) > maxEmbedPerPhase {
		out = out[:maxEmbedPerPhase]
		hasMore = true
	}
	return out, hasMore, nil
}

func nullableInt(v *int32) any {
	if v == nil {
		return nil
	}
	return *v
}

// writeIndexEmbeddings 分批生成向量并回写索引行；失败时标记 failed 并抛出。
func writeIndexEmbeddings(q execQuerier, userID int64, rowsIn []pendingIndexRow, profile *embeddingProfile) (int, error) {
	written := 0
	for offset := 0; offset < len(rowsIn); offset += indexBatchSize {
		end := offset + indexBatchSize
		if end > len(rowsIn) {
			end = len(rowsIn)
		}
		batch := rowsIn[offset:end]
		texts := make([]string, 0, len(batch))
		for _, row := range batch {
			texts = append(texts, row.embeddingText)
		}
		vectors, err := EmbedInvoker(context.Background(), EmbedRequest{
			UserID: userID, Texts: texts, Op: "kb.article-index",
		})
		if err != nil {
			message := truncateRunes(err.Error(), 1000)
			for _, row := range batch {
				_, _ = q.Exec(context.Background(),
					`UPDATE petrichor_kb_article_chunk_index SET embedding_status = 'failed',
					 embedding_error = $1, embedding_updated_at = now() WHERE id = $2`, message, row.id)
			}
			return written, err
		}
		for i, row := range batch {
			if i >= len(vectors) {
				continue
			}
			literal := vectorLiteral(vectors[i])
			if literal == "" {
				continue
			}
			if _, uerr := q.Exec(context.Background(),
				`UPDATE petrichor_kb_article_chunk_index SET embedding = $1::vector,
				 embedding_status = 'ready', embedding_model = $2, embedding_dimensions = $3,
				 embedding_version = $4, embedding_error = NULL, embedding_updated_at = now(), updated_at = now()
				 WHERE id = $5`,
				literal, profile.model, int32(len(vectors[i])), profile.version, row.id); uerr != nil {
				return written, uerr
			}
			written++
		}
	}
	return written, nil
}

func vectorLiteral(vec []float32) string {
	if len(vec) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteByte('[')
	for i, v := range vec {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(v), 'f', -1, 32))
	}
	b.WriteByte(']')
	return b.String()
}

func truncateRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

// WikiEmbeddingRun 两阶段向量化：全部分片就绪后才进入问题阶段。
func WikiEmbeddingRun(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		if err := requireEmbed(); err != nil {
			return nil, err
		}
		q := pool()
		profile, err := loadEmbeddingProfileOrNull(q, user.ID)
		if err != nil {
			return nil, err
		}
		if profile == nil {
			return nil, badReq("未配置向量模型：请先在「AI 模型配置」绑定 EMBEDDING 模型")
		}
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}

		chunkRows, chunkHasMore, err := loadPendingIndexRows(q, user.ID, kbID, "chunk", profile)
		if err != nil {
			return nil, err
		}
		embeddedChunks, err := writeIndexEmbeddings(q, user.ID, chunkRows, profile)
		if err != nil {
			return nil, err
		}

		embeddedQuestions := 0
		if !chunkHasMore {
			remaining, _, err := loadPendingIndexRows(q, user.ID, kbID, "chunk", profile)
			if err != nil {
				return nil, err
			}
			if len(remaining) == 0 {
				questionRows, _, qerr := loadPendingIndexRows(q, user.ID, kbID, "question", profile)
				if qerr != nil {
					return nil, qerr
				}
				embeddedQuestions, err = writeIndexEmbeddings(q, user.ID, questionRows, profile)
				if err != nil {
					return nil, err
				}
			}
		}

		status, err := getArticleIndexStatus(q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		ready := status["embedded"]
		delete(status, "supported")
		delete(status, "embedded")
		result := map[string]any{
			"embedded":          embeddedChunks + embeddedQuestions,
			"embeddedChunks":    embeddedChunks,
			"embeddedQuestions": embeddedQuestions,
			"ready":             ready,
		}
		for k, v := range status {
			result[k] = v
		}
		return result, nil
	})
}
