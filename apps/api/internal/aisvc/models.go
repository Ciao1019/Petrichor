// models.go 对照 provider-handlers.ts 的模型部分 + embedding.ts：
// model/list、model/toggle、model/probe-dimensions（发一次最短 embed 量维度并回写）。
package aisvc

import (
	"context"
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const (
	minDimensions          = 8
	maxDimensions          = 16000
	maxIndexableDimensions = 2000
)

type vectorTable struct{ table, column string }

// 带向量列的表，与 TS retrieval/vector-space.ts 的 VECTOR_TABLES 一致
var vectorTables = []vectorTable{
	{"petrichor_kb_article_chunk_index", "embedding"},
	{"petrichor_kb_wiki_tree_node", "embedding"},
	{"petrichor_agent_memory", "embedding"},
	{"petrichor_assistant_message_embedding", "embedding"},
}

func isValidDimensions(v int64) bool {
	return v >= minDimensions && v <= maxDimensions
}

// ListModels POST /api/ai/model/list。
func ListModels(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	where := ` WHERE m.user_id = $1`
	args := []any{user.ID}
	if body["providerId"] != nil {
		providerID, err := requireID(body["providerId"], "供应商 ID")
		if err != nil {
			httpx.HandleError(c, err)
			return
		}
		args = append(args, providerID)
		where += fmt.Sprintf(" AND m.provider_id = $%d", len(args))
	}
	if kind := strings.TrimSpace(flexToString(body["kind"])); kind == "LANGUAGE" || kind == "EMBEDDING" {
		args = append(args, kind)
		where += fmt.Sprintf(" AND m.kind = $%d", len(args))
	}
	if truthy(body["enabledOnly"]) {
		where += ` AND m.enabled = true`
	}

	rows, err := db.Pool().Query(ctx, `
		SELECT `+modelColsP+`, p.name, p.provider_key
		FROM petrichor_ai_model m
		JOIN petrichor_ai_provider p ON p.id = m.provider_id`+where+`
		ORDER BY p.name, m.kind, m.model_id`, args...)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	defer rows.Close()

	items := []gin.H{}
	for rows.Next() {
		var rec modelRowFull
		dest := rec.scanInto()
		var providerName, providerKey *string
		dest = append(dest, &providerName, &providerKey)
		if err := rows.Scan(dest...); err != nil {
			httpx.HandleError(c, err)
			return
		}
		items = append(items, buildModelResponse(rec, providerName, providerKey))
	}
	httpx.OK(c, gin.H{"items": items})
}

// ToggleModel POST /api/ai/model/toggle：单个模型的启用开关。
func ToggleModel(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	id, err := requireID(body["id"], "模型 ID")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	enabled := truthy(body["enabled"])

	var rec modelRowFull
	err = db.Pool().QueryRow(ctx,
		`UPDATE petrichor_ai_model SET enabled = $1, updated_at = now()
		 WHERE id = $2 AND user_id = $3 RETURNING `+modelCols,
		enabled, id, user.ID).Scan(rec.scanInto()...)
	if err == pgx.ErrNoRows {
		httpx.HandleError(c, httpx.NotFound("模型不存在"))
		return
	}
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, buildModelResponse(rec, nil, nil))
}

// ProbeModelDimensions POST /api/ai/model/probe-dimensions。
// 各家的 /models 都不返回维度，唯一可靠的办法是发一次最短的 embed 请求量返回长度，
// 结果写回模型记录，供绑定界面展示。
func ProbeModelDimensions(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	ctx := c.Request.Context()

	id, err := requireID(body["id"], "模型 ID")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	var (
		modelID     string
		kind        string
		providerKey string
		baseURL     *string
		headersJSON *string
		apiKeyEnc   string
		extraEnc    *string
	)
	err = db.Pool().QueryRow(ctx, `
		SELECT m.model_id, m.kind, p.provider_key, p.base_url, p.headers_json, c.api_key_enc, c.extra_enc
		FROM petrichor_ai_model m
		JOIN petrichor_ai_provider p ON p.id = m.provider_id
		JOIN petrichor_ai_credential c ON c.id = p.credential_id
		WHERE m.id = $1 AND m.user_id = $2
		LIMIT 1`, id, user.ID).
		Scan(&modelID, &kind, &providerKey, &baseURL, &headersJSON, &apiKeyEnc, &extraEnc)
	if err == pgx.ErrNoRows {
		httpx.HandleError(c, httpx.NotFound("模型不存在"))
		return
	}
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if kind != "EMBEDDING" {
		httpx.HandleError(c, badRequestMsg("只有向量模型需要探测维度"))
		return
	}

	rt := aicore.BuildRuntimeConfig(providerKey, derefStr(baseURL),
		aicore.DecodeApiKey(apiKeyEnc), aicore.DecodeExtra(derefStr(extraEnc)),
		parseStringMapPtr(headersJSON), aicore.Quirks{})

	dimensions, probeErr := probeEmbeddingDimensions(ctx, rt, modelID)
	if probeErr != nil {
		message := probeErr.Error()
		if message == "" {
			message = "调用失败"
		}
		httpx.HandleError(c, badRequestMsg("探测维度失败：%s", message))
		return
	}
	if persistErr := persistDimensions(ctx, id, dimensions); persistErr != nil {
		httpx.HandleError(c, badRequestMsg("探测维度失败：%s", persistErr.Error()))
		return
	}

	indexable := dimensions <= maxIndexableDimensions
	var warning any
	if !indexable {
		warning = fmt.Sprintf("该模型输出 %d 维，超过 pgvector HNSW 索引上限 %d，检索会退化为顺序扫描",
			dimensions, maxIndexableDimensions)
	}
	httpx.OK(c, gin.H{
		"id":         idStr(id),
		"modelId":    modelID,
		"dimensions": dimensions,
		"indexable":  indexable,
		"warning":    warning,
	})
}

// ===== 向量探测与落库（embedding.ts 移植）=====

// probeEmbeddingDimensions 发一次最短的 embed 请求，量一下返回长度。
func probeEmbeddingDimensions(ctx context.Context, rt aicore.RuntimeConfig, modelID string) (int64, error) {
	vectors, err := aicore.Embeddings(ctx, rt, modelID, []string{"dimension probe"})
	if err != nil {
		return 0, err
	}
	if len(vectors) == 0 || len(vectors[0]) == 0 {
		return 0, badRequestMsg("模型返回的向量维度异常：0")
	}
	dimensions := int64(len(vectors[0]))
	if !isValidDimensions(dimensions) {
		return 0, badRequestMsg("模型返回的向量维度异常：%d", dimensions)
	}
	return dimensions, nil
}

// persistDimensions 把探测到的维度写回模型记录，并补齐该维度的向量索引。
func persistDimensions(ctx context.Context, modelRefID int64, dimensions int64) error {
	if !isValidDimensions(dimensions) {
		return badRequestMsg("模型返回的向量维度异常：%d", dimensions)
	}
	if _, err := db.Pool().Exec(ctx,
		`UPDATE petrichor_ai_model SET dimensions = $1, updated_at = now() WHERE id = $2`,
		int32(dimensions), modelRefID); err != nil {
		return err
	}
	// 新维度首次出现时补建部分索引；已存在则是一次无开销的 if not exists
	return ensureVectorIndexes(ctx, dimensions)
}

// ensureVectorIndexes 为某个维度补齐各向量表的部分 HNSW 索引（复刻 vector-space.ts）。
// 超过 pgvector 上限时跳过建索引——查询降级为顺序扫描，功能仍然正确。
func ensureVectorIndexes(ctx context.Context, dimensions int64) error {
	if !isValidDimensions(dimensions) || dimensions > maxIndexableDimensions {
		return nil
	}
	for _, vt := range vectorTables {
		name := "idx_petrichor_" + strings.TrimPrefix(vt.table, "petrichor_") +
			fmt.Sprintf("_%s_d%d", vt.column, dimensions)
		stmt := fmt.Sprintf(
			"create index if not exists %s on %s "+
				"using hnsw ((%s::vector(%d)) vector_cosine_ops) "+
				"where vector_dims(%s) = %d",
			name, vt.table, vt.column, dimensions, vt.column, dimensions)
		if _, err := db.Pool().Exec(ctx, stmt); err != nil {
			return err
		}
	}
	return nil
}
