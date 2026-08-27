package assistantsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"petrichor/api/internal/aicore"
	rt "petrichor/api/internal/assistantsvc/runtime"
)

const (
	assistantRecallTopK        = 4
	assistantRecallMinScore    = 0.25
	assistantRecallEmbedBatch  = 16
	assistantRecallExcerptMax  = 500
	operatorUserProfileMax     = 1375
	operatorAgentNotesMax      = 2200
	operatorMemoryTotalMax     = 3575
	operatorMemoryPromptTitle  = "操作员常驻记忆（本线程冻结快照）"
	contextRecallEnsureTimeout = 60 * time.Second
)

var (
	recallOpenAIKeyPattern = regexp.MustCompile(`sk-[a-zA-Z0-9]{10,}`)
	recallSecretPattern    = regexp.MustCompile(`(?i)(api[_-]?key|token|secret|password|cookie)\s*[:=]\s*\S+`)
	recallBearerPattern    = regexp.MustCompile(`(?i)bearer\s+[a-zA-Z0-9._-]+`)
	recallOutcomePattern   = regexp.MustCompile(`(?i)executionOutcome[\s\S]{0,200}`)
)

type assistantRecalledSnippet struct {
	MessageID string
	Score     float64
	Excerpt   string
}

type operatorMemorySnapshot struct {
	UserProfileMd string `json:"userProfileMd"`
	AgentNotesMd  string `json:"agentNotesMd"`
	FrozenAt      string `json:"frozenAt"`
}

func buildAssistantBackground(summary string, recalled []assistantRecalledSnippet, operatorMemory string) string {
	sections := make([]string, 0, 3)
	if strings.TrimSpace(summary) != "" {
		sections = append(sections,
			"以下是本对话较早内容的摘要（已折叠细节，仅供连贯理解；最近几轮原文仍在消息中）：\n"+strings.TrimSpace(summary))
	}
	if len(recalled) > 0 {
		lines := []string{"以下是与当前问题相关的较早对话片段（向量召回，供参考，非完整历史）："}
		for index, item := range recalled {
			lines = append(lines, fmt.Sprintf("%d. (相关度 %.2f) %s", index+1, item.Score, item.Excerpt))
		}
		sections = append(sections, strings.Join(lines, "\n"))
	}
	if strings.TrimSpace(operatorMemory) != "" {
		sections = append(sections, strings.TrimSpace(operatorMemory))
	}
	return strings.Join(sections, "\n\n")
}

func recallAssistantHistoryBestEffort(
	ctx context.Context,
	userID, threadID int64,
	messages []map[string]any,
	recentCount, persistedCount int,
) []assistantRecalledSnippet {
	if persistedCount <= recentCount {
		return nil
	}
	query := lastRuntimeUserText(messages)
	if query == "" {
		return nil
	}
	excluded := listRecentAssistantMessageIDs(ctx, threadID, recentCount)
	snippets := recallAssistantHistory(ctx, userID, threadID, query, excluded, assistantRecallTopK)

	// 和 TS 一致：热路径只读已有向量，缺失向量后台补齐，绝不阻塞当前回答。
	backgroundCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), contextRecallEnsureTimeout)
	go func() {
		defer cancel()
		ensureAssistantMessageEmbeddings(backgroundCtx, userID, threadID, excluded)
	}()
	return snippets
}

func recallAssistantHistory(
	ctx context.Context,
	userID, threadID int64,
	query string,
	excluded []int64,
	limit int,
) []assistantRecalledSnippet {
	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeEmbedding, nil)
	if err != nil {
		return nil
	}
	vectors, err := aicore.Embeddings(ctx, resolved.Runtime, resolved.ModelRef, []string{truncateStoreText(query, 4000)})
	if err != nil || len(vectors) == 0 || len(vectors[0]) == 0 {
		return nil
	}
	vector := vectors[0]
	if limit <= 0 || limit > 12 {
		limit = assistantRecallTopK
	}
	rows, err := dbPool().Query(ctx, `
		SELECT message_id, excerpt_md, (1 - (embedding <=> $3::vector))::float8 AS score
		FROM petrichor_assistant_message_embedding
		WHERE thread_id=$1 AND user_id=$2 AND embedding IS NOT NULL
		  AND vector_dims(embedding)=$4
		  AND NOT (message_id = ANY($5::bigint[]))
		ORDER BY embedding <=> $3::vector
		LIMIT $6`, threadID, userID, embeddingVectorLiteral(vector), len(vector), excluded, limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := make([]assistantRecalledSnippet, 0, limit)
	for rows.Next() {
		var messageID int64
		var excerpt string
		var score float64
		if rows.Scan(&messageID, &excerpt, &score) != nil || score < assistantRecallMinScore {
			continue
		}
		excerpt = sanitizeRecallExcerpt(excerpt)
		if excerpt == "" {
			continue
		}
		out = append(out, assistantRecalledSnippet{
			MessageID: idStr(messageID), Score: score, Excerpt: excerpt,
		})
	}
	return out
}

func listRecentAssistantMessageIDs(ctx context.Context, threadID int64, limit int) []int64 {
	if limit < 1 {
		limit = 1
	}
	rows, err := dbPool().Query(ctx, `
		SELECT id FROM petrichor_assistant_message
		WHERE thread_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`, threadID, limit)
	if err != nil {
		return []int64{}
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

func ensureAssistantMessageEmbeddings(ctx context.Context, userID, threadID int64, excluded []int64) {
	if ctx.Err() != nil {
		return
	}
	excludedSet := map[int64]bool{}
	for _, id := range excluded {
		excludedSet[id] = true
	}
	rows, err := dbPool().Query(ctx, `
		SELECT id, role, content_json FROM petrichor_assistant_message
		WHERE thread_id=$1 ORDER BY created_at ASC, id ASC LIMIT 200`, threadID)
	if err != nil {
		return
	}
	type candidate struct {
		id      int64
		excerpt string
	}
	candidates := []candidate{}
	for rows.Next() {
		var id int64
		var role, contentJSON string
		if rows.Scan(&id, &role, &contentJSON) != nil || excludedSet[id] {
			continue
		}
		excerpt := sanitizeRecallExcerpt(extractPersistedAssistantText(role, contentJSON))
		if len([]rune(excerpt)) >= 8 {
			candidates = append(candidates, candidate{id: id, excerpt: excerpt})
		}
	}
	rows.Close()
	if len(candidates) == 0 || ctx.Err() != nil {
		return
	}

	existingRows, err := dbPool().Query(ctx, `
		SELECT message_id FROM petrichor_assistant_message_embedding
		WHERE thread_id=$1 AND user_id=$2`, threadID, userID)
	if err != nil {
		return
	}
	existing := map[int64]bool{}
	for existingRows.Next() {
		var id int64
		if existingRows.Scan(&id) == nil {
			existing[id] = true
		}
	}
	existingRows.Close()
	pending := make([]candidate, 0, assistantRecallEmbedBatch)
	for _, item := range candidates {
		if !existing[item.id] {
			pending = append(pending, item)
			if len(pending) == assistantRecallEmbedBatch {
				break
			}
		}
	}
	if len(pending) == 0 {
		return
	}

	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeEmbedding, nil)
	if err != nil {
		return
	}
	texts := make([]string, len(pending))
	for index, item := range pending {
		texts[index] = item.excerpt
	}
	vectors, err := aicore.Embeddings(ctx, resolved.Runtime, resolved.ModelRef, texts)
	if err != nil {
		return
	}
	for index, item := range pending {
		if index >= len(vectors) || len(vectors[index]) == 0 || ctx.Err() != nil {
			continue
		}
		_, _ = dbPool().Exec(ctx, `
			INSERT INTO petrichor_assistant_message_embedding
				(message_id, thread_id, user_id, excerpt_md, embedding, created_at)
			VALUES ($1,$2,$3,$4,$5::vector,now())
			ON CONFLICT (message_id) DO UPDATE SET
				excerpt_md=excluded.excerpt_md, embedding=excluded.embedding`,
			item.id, threadID, userID, item.excerpt, embeddingVectorLiteral(vectors[index]))
	}
}

func sanitizeRecallExcerpt(text string) string {
	text = recallOpenAIKeyPattern.ReplaceAllString(text, "[redacted]")
	text = recallSecretPattern.ReplaceAllString(text, "$1=[redacted]")
	text = recallBearerPattern.ReplaceAllString(text, "Bearer [redacted]")
	text = recallOutcomePattern.ReplaceAllString(text, "[confirmation omitted]")
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(strings.TrimSpace(text))
	if len(runes) <= assistantRecallExcerptMax {
		return string(runes)
	}
	return string(runes[:assistantRecallExcerptMax]) + "…"
}

func extractPersistedAssistantText(role, contentJSON string) string {
	var value any
	if json.Unmarshal([]byte(contentJSON), &value) != nil {
		return strings.TrimSpace(role + ": " + contentJSON)
	}
	parts := []string{}
	collectPersistedText(value, &parts)
	return strings.TrimSpace(role + ": " + strings.Join(parts, "\n"))
}

func collectPersistedText(value any, out *[]string) {
	switch current := value.(type) {
	case string:
		if strings.TrimSpace(current) != "" {
			*out = append(*out, current)
		}
	case []any:
		for _, item := range current {
			collectPersistedText(item, out)
		}
	case map[string]any:
		if text, ok := current["text"].(string); ok && strings.TrimSpace(text) != "" {
			*out = append(*out, text)
			return
		}
		if content, exists := current["content"]; exists {
			collectPersistedText(content, out)
		}
		if parts, exists := current["parts"]; exists {
			collectPersistedText(parts, out)
		}
	}
}

func lastRuntimeUserText(messages []map[string]any) string {
	for index := len(messages) - 1; index >= 0; index-- {
		if messages[index]["role"] != "user" {
			continue
		}
		if text, ok := messages[index]["content"].(string); ok {
			return strings.TrimSpace(text)
		}
	}
	return ""
}

func embeddingVectorLiteral(vector []float32) string {
	parts := make([]string, len(vector))
	for index, value := range vector {
		parts[index] = fmt.Sprintf("%g", value)
	}
	return "[" + strings.Join(parts, ",") + "]"
}

func loadOperatorMemoryBackground(ctx context.Context, userID, threadID int64, systemRole string) string {
	if !rt.IsAssistantOperator(systemRole) {
		return ""
	}
	var rawSnapshot *string
	if dbPool().QueryRow(ctx, `
		SELECT operator_memory_snapshot_json FROM petrichor_assistant_thread
		WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, threadID, userID).Scan(&rawSnapshot) != nil {
		return ""
	}
	if snapshot := parseOperatorMemorySnapshot(rawSnapshot); snapshot != nil {
		return formatOperatorMemory(*snapshot)
	}

	var profile, notes string
	_ = dbPool().QueryRow(ctx, `
		SELECT user_profile_md, agent_notes_md FROM petrichor_assistant_operator_profile
		WHERE user_id=$1 LIMIT 1`, userID).Scan(&profile, &notes)
	snapshot := operatorMemorySnapshot{
		UserProfileMd: profile, AgentNotesMd: notes, FrozenAt: time.Now().UTC().Format(time.RFC3339Nano),
	}
	encoded, _ := json.Marshal(snapshot)
	_, _ = dbPool().Exec(ctx, `
		UPDATE petrichor_assistant_thread SET operator_memory_snapshot_json=$1, updated_at=now()
		WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL`, string(encoded), threadID, userID)
	return formatOperatorMemory(snapshot)
}

func parseOperatorMemorySnapshot(raw *string) *operatorMemorySnapshot {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var snapshot operatorMemorySnapshot
	if json.Unmarshal([]byte(*raw), &snapshot) != nil {
		return nil
	}
	if len([]rune(snapshot.UserProfileMd)) > operatorUserProfileMax ||
		len([]rune(snapshot.AgentNotesMd)) > operatorAgentNotesMax ||
		len([]rune(snapshot.UserProfileMd))+len([]rune(snapshot.AgentNotesMd)) > operatorMemoryTotalMax {
		return nil
	}
	return &snapshot
}

func formatOperatorMemory(snapshot operatorMemorySnapshot) string {
	profile := strings.TrimSpace(snapshot.UserProfileMd)
	if profile == "" {
		profile = "（空）"
	}
	notes := strings.TrimSpace(snapshot.AgentNotesMd)
	if notes == "" {
		notes = "（空）"
	}
	return strings.Join([]string{
		operatorMemoryPromptTitle, "", "## 用户画像", profile, "", "## 约定与笔记", notes,
	}, "\n")
}
