package assistantsvc

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/aicore"
	rt "petrichor/api/internal/assistantsvc/runtime"
)

const (
	memorySearchSchema = `{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":500},"mode":{"type":"string","enum":["keyword","semantic","both"]},"limit":{"type":"integer","minimum":1,"maximum":20},"excludeCurrentThread":{"type":"boolean"}},"required":["query"]}`
	memoryWriteSchema  = `{"type":"object","properties":{"target":{"type":"string","enum":["user_profile","agent_notes"]},"text":{"type":"string","minLength":1,"maxLength":2000}},"required":["target","text"]}`
	memoryUpdateSchema = `{"type":"object","properties":{"target":{"type":"string","enum":["user_profile","agent_notes"]},"oldText":{"type":"string","minLength":1,"maxLength":2000},"newText":{"type":"string","minLength":1,"maxLength":2000}},"required":["target","oldText","newText"]}`
	memoryDeleteSchema = `{"type":"object","properties":{"target":{"type":"string","enum":["user_profile","agent_notes"]},"oldText":{"type":"string","minLength":1,"maxLength":2000}},"required":["target","oldText"]}`
)

type operatorHistoryHit struct {
	ThreadID  string  `json:"threadId"`
	MessageID string  `json:"messageId"`
	Excerpt   string  `json:"excerpt"`
	Score     float64 `json:"score"`
	Source    string  `json:"source"`
}

func registerMemoryTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "memory.search", Name: "search_operator_history", Namespace: rt.NamespaceMemory,
		Description: "跨线程检索操作员历史对话（关键词全文检索 + 语义向量）；当前对话已经出现的内容无需调用。",
		InputSchema: schemaJSON(memorySearchSchema), RiskLevel: rt.RiskLow,
		RequiresOperator: true, Tags: []string{"retrieval"}, Execute: executeMemorySearch,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			raw, _ := json.Marshal(output)
			var record struct {
				Hits []operatorHistoryHit `json:"hits"`
			}
			_ = json.Unmarshal(raw, &record)
			summary := "历史对话中没有相关记录"
			if len(record.Hits) > 0 {
				summary = fmt.Sprintf("历史对话中找到 %d 条记录", len(record.Hits))
			}
			return rt.ToolNormalizerResult{Summary: summary, Data: mustJSON(map[string]any{"hits": record.Hits}), Progress: boolPtr(len(record.Hits) > 0)}
		},
	})

	registerMemoryMutationTool(registry, &rt.AgentToolDefinition{
		ID: "memory.write", Name: "memory_write", InputSchema: schemaJSON(memoryWriteSchema),
		Description: "写入一条长期记忆；仅用于用户明确要求记住、或长期有效且影响后续协作的信息。",
		Execute: func(ctx *rt.ToolExecutionContext, input any) (any, error) {
			params, _ := input.(map[string]any)
			return mutateOperatorMemory(ctx, "add", stringValue(params["target"]), stringValue(params["text"]), "")
		},
	}, "写入")

	registerMemoryMutationTool(registry, &rt.AgentToolDefinition{
		ID: "memory.update", Name: "memory_update", InputSchema: schemaJSON(memoryUpdateSchema),
		Description: "按完全一致的原文修改一条长期记忆；不确定原文时先调用 memory.search。",
		Execute: func(ctx *rt.ToolExecutionContext, input any) (any, error) {
			params, _ := input.(map[string]any)
			return mutateOperatorMemory(ctx, "replace", stringValue(params["target"]), stringValue(params["oldText"]), stringValue(params["newText"]))
		},
	}, "更新")

	registerMemoryMutationTool(registry, &rt.AgentToolDefinition{
		ID: "memory.delete", Name: "memory_delete", InputSchema: schemaJSON(memoryDeleteSchema),
		Description: "按完全一致的原文删除一条已失效的长期记忆；不要因本轮用不到就删除。",
		Execute: func(ctx *rt.ToolExecutionContext, input any) (any, error) {
			params, _ := input.(map[string]any)
			return mutateOperatorMemory(ctx, "remove", stringValue(params["target"]), stringValue(params["oldText"]), "")
		},
	}, "删除")
}

func registerMemoryMutationTool(registry interface {
	Register(tool *rt.AgentToolDefinition)
}, tool *rt.AgentToolDefinition, actionLabel string) {
	tool.Namespace = rt.NamespaceMemory
	tool.RiskLevel = rt.RiskMedium
	tool.SideEffect = true
	tool.AllowedInSubAgent = toolPtr(false)
	tool.RequiresOperator = true
	tool.Permissions = []string{rt.PermissionMemoryWrite}
	tool.Normalize = func(output any, _ any) rt.ToolNormalizerResult {
		record, _ := output.(map[string]any)
		ok, _ := record["ok"].(bool)
		if !ok {
			errorCode, _ := record["errorCode"].(string)
			actions := []string{"fix_arguments"}
			if errorCode == "assistant_operator_only" {
				actions = []string{"explain_permission_limit"}
			}
			return rt.ToolNormalizerResult{Summary: fmt.Sprintf("记忆%s失败：%s", actionLabel, errorCode), SuggestedActions: actions, Progress: boolPtr(false)}
		}
		return rt.ToolNormalizerResult{
			Summary:  fmt.Sprintf("记忆已%s", actionLabel),
			Data:     mustJSON(map[string]any{"userProfileChars": record["userProfileChars"], "agentNotesChars": record["agentNotesChars"]}),
			Progress: boolPtr(true),
		}
	}
	registry.Register(tool)
}

func executeMemorySearch(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if !rt.IsAssistantOperator(ctx.SystemRole) {
		return map[string]any{"ok": false, "errorCode": "assistant_operator_only", "hits": []operatorHistoryHit{}}, nil
	}
	params, _ := input.(map[string]any)
	query := strings.TrimSpace(stringValue(params["query"]))
	if query == "" {
		return nil, rt.ValidationError("query 不能为空")
	}
	mode := stringValue(params["mode"])
	if mode == "" {
		mode = "both"
	}
	limit := intValue(params["limit"])
	if limit <= 0 || limit > 20 {
		limit = 8
	}
	excludeCurrent := true
	if value, exists := params["excludeCurrentThread"].(bool); exists {
		excludeCurrent = value
	}

	keyword := []operatorHistoryHit{}
	semantic := []operatorHistoryHit{}
	threadID := parseID(ctx.ConversationID)
	if mode == "keyword" || mode == "both" {
		keyword = searchOperatorHistoryKeyword(toolContext(ctx), ctx.UserID, threadID, query, limit, excludeCurrent)
	}
	if mode == "semantic" || mode == "both" {
		semantic = searchOperatorHistorySemantic(toolContext(ctx), ctx.UserID, threadID, query, limit, excludeCurrent)
	}
	hits := mergeOperatorHistoryHits(semantic, keyword, limit)
	return map[string]any{"ok": true, "hits": hits}, nil
}

func searchOperatorHistoryKeyword(ctx context.Context, userID, threadID int64, query string, limit int, exclude bool) []operatorHistoryHit {
	rows, err := dbPool().Query(ctx, `
		SELECT e.thread_id, e.message_id, e.excerpt_md,
		       ts_rank(to_tsvector('simple', COALESCE(e.excerpt_md,'')), plainto_tsquery('simple',$2))::float8 AS score
		FROM petrichor_assistant_message_embedding e
		WHERE e.user_id=$1 AND ($3::boolean=false OR e.thread_id<>$4)
		  AND to_tsvector('simple',COALESCE(e.excerpt_md,'')) @@ plainto_tsquery('simple',$2)
		ORDER BY score DESC LIMIT $5`, userID, query, exclude, threadID, limit)
	if err != nil {
		pattern := "%" + sanitizeLike(truncateRunes(query, 80)) + "%"
		rows, err = dbPool().Query(ctx, `
			SELECT e.thread_id, e.message_id, e.excerpt_md, 0.5::float8 AS score
			FROM petrichor_assistant_message_embedding e
			WHERE e.user_id=$1 AND ($2::boolean=false OR e.thread_id<>$3) AND e.excerpt_md ILIKE $4 ESCAPE '\\'
			ORDER BY e.message_id DESC LIMIT $5`, userID, exclude, threadID, pattern, limit)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()
	return scanOperatorHistoryHits(rows, "keyword", false)
}

func searchOperatorHistorySemantic(ctx context.Context, userID, threadID int64, query string, limit int, exclude bool) []operatorHistoryHit {
	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeEmbedding, nil)
	if err != nil {
		return nil
	}
	vectors, err := aicore.Embeddings(ctx, resolved.Runtime, resolved.ModelRef, []string{truncateRunes(query, 4000)})
	if err != nil || len(vectors) == 0 || len(vectors[0]) == 0 {
		return nil
	}
	vector := vectors[0]
	rows, err := dbPool().Query(ctx, `
		SELECT e.thread_id, e.message_id, e.excerpt_md, (1-(e.embedding <=> $5::vector))::float8 AS score
		FROM petrichor_assistant_message_embedding e
		WHERE e.user_id=$1 AND ($2::boolean=false OR e.thread_id<>$3)
		  AND e.embedding IS NOT NULL AND vector_dims(e.embedding)=$4
		ORDER BY e.embedding <=> $5::vector LIMIT $6`,
		userID, exclude, threadID, len(vector), embeddingVectorLiteral(vector), limit)
	if err != nil {
		return nil
	}
	defer rows.Close()
	return scanOperatorHistoryHits(rows, "semantic", true)
}

type historyRows interface {
	Next() bool
	Scan(dest ...any) error
}

func scanOperatorHistoryHits(rows historyRows, source string, filterScore bool) []operatorHistoryHit {
	hits := []operatorHistoryHit{}
	for rows.Next() {
		var threadID, messageID int64
		var excerpt string
		var score float64
		if rows.Scan(&threadID, &messageID, &excerpt, &score) != nil || (filterScore && score < assistantRecallMinScore) {
			continue
		}
		excerpt = sanitizeRecallExcerpt(excerpt)
		if excerpt == "" {
			continue
		}
		hits = append(hits, operatorHistoryHit{ThreadID: idStr(threadID), MessageID: idStr(messageID), Excerpt: excerpt, Score: score, Source: source})
	}
	return hits
}

func mergeOperatorHistoryHits(primary, secondary []operatorHistoryHit, limit int) []operatorHistoryHit {
	seen := map[string]bool{}
	out := make([]operatorHistoryHit, 0, minInt(limit, len(primary)+len(secondary)))
	for _, list := range [][]operatorHistoryHit{primary, secondary} {
		for _, hit := range list {
			key := hit.ThreadID + ":" + hit.MessageID
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, hit)
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

func mutateOperatorMemory(ctx *rt.ToolExecutionContext, action, target, oldText, newText string) (any, error) {
	if !rt.IsAssistantOperator(ctx.SystemRole) {
		return map[string]any{"ok": false, "errorCode": "assistant_operator_only"}, nil
	}
	var profile, notes string
	err := dbPool().QueryRow(toolContext(ctx), `
		SELECT user_profile_md, agent_notes_md FROM petrichor_assistant_operator_profile
		WHERE user_id=$1 LIMIT 1`, ctx.UserID).Scan(&profile, &notes)
	if err != nil && err != pgx.ErrNoRows {
		return nil, err
	}
	nextProfile, nextNotes, errorCode := applyOperatorMemoryMutation(profile, notes, action, target, oldText, newText)
	if errorCode != "" {
		return map[string]any{"ok": false, "errorCode": errorCode}, nil
	}
	_, err = dbPool().Exec(toolContext(ctx), `
		INSERT INTO petrichor_assistant_operator_profile (user_id,user_profile_md,agent_notes_md,updated_at)
		VALUES ($1,$2,$3,now())
		ON CONFLICT (user_id) DO UPDATE SET
		  user_profile_md=excluded.user_profile_md, agent_notes_md=excluded.agent_notes_md, updated_at=excluded.updated_at`,
		ctx.UserID, nextProfile, nextNotes)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok": true, "userProfileChars": len([]rune(nextProfile)), "agentNotesChars": len([]rune(nextNotes)), "applied": "profile_only",
	}, nil
}

func applyOperatorMemoryMutation(profile, notes, action, target, oldText, newText string) (string, string, string) {
	if target != "user_profile" && target != "agent_notes" {
		return profile, notes, "invalid_patch"
	}
	current := profile
	if target == "agent_notes" {
		current = notes
	}
	next := current
	switch action {
	case "add":
		text := strings.TrimSpace(oldText)
		if text == "" {
			return profile, notes, "invalid_patch"
		}
		if strings.TrimSpace(current) == "" {
			next = text
		} else {
			next = strings.TrimRight(current, " \t\r\n") + "\n" + text
		}
	case "replace":
		if oldText == "" || !strings.Contains(current, oldText) {
			return profile, notes, "invalid_patch"
		}
		next = strings.Replace(current, oldText, newText, 1)
	case "remove":
		if oldText == "" || !strings.Contains(current, oldText) {
			return profile, notes, "invalid_patch"
		}
		next = strings.Replace(current, oldText, "", 1)
	default:
		return profile, notes, "invalid_patch"
	}
	if target == "user_profile" {
		profile = next
	} else {
		notes = next
	}
	if len([]rune(profile)) > operatorUserProfileMax || len([]rune(notes)) > operatorAgentNotesMax || len([]rune(profile))+len([]rune(notes)) > operatorMemoryTotalMax {
		return profile, notes, "memory_limit_exceeded"
	}
	return profile, notes, ""
}
