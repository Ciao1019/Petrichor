// agentrun-view.go Run 视图组装（对照 store.ts loadAgentRunViewUnsafe / loadAgentRunTraceUnsafe / toPublicEvidence）。
package assistantsvc

import (
	"context"
	"encoding/json"

	httpx "petrichor/api/internal/httpx"
)

// loadAgentRunView 普通 Agent Run 视图：不含 raw tool args、内部 prompt、隐藏推理。
func loadAgentRunView(ctx context.Context, runKey string, userID int64) (map[string]any, error) {
	run, err := scanAgentRun(dbPool().QueryRow(ctx,
		`SELECT `+agentRunColumns+` FROM petrichor_agent_run
		 WHERE run_key = $1 AND user_id = $2 LIMIT 1`, runKey, userID))
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, err
	}

	events, err := queryTraceEventsOrdered(ctx, runKey)
	if err != nil {
		return nil, err
	}
	evidenceRows, err := queryEvidenceOrdered(ctx, runKey)
	if err != nil {
		return nil, err
	}
	subtaskRows, err := querySubtasksOrdered(ctx, runKey)
	if err != nil {
		return nil, err
	}

	activities := []map[string]any{}
	for _, event := range events {
		if event.EventType != "tool_result" && event.EventType != "error" {
			continue
		}
		payload := parseJSONMap(event.PayloadJSON)
		if payload == nil || payload["toolId"] == nil {
			continue
		}
		status := "failed"
		if okVal, _ := payload["ok"].(bool); okVal {
			status = "completed"
		}
		activities = append(activities, map[string]any{
			"id":          anyToStringOr(payload["id"], idStr(event.ID)),
			"toolId":      anyToStringOr(payload["toolId"], ""),
			"namespace":   anyToStringOr(payload["namespace"], "system"),
			"status":      status,
			"summary":     anyToStringOr(payload["summary"], ""),
			"durationMs":  anyToFloatOr(payload["durationMs"], 0),
			"evidenceIds": anyToStringArrayOr(payload["evidenceIds"]),
			"startedAt":   anyToFloatOr(payload["startedAt"], event.CreatedAt.UnixMilli()),
		})
	}

	evidence := make([]map[string]any, 0, len(evidenceRows))
	for i := range evidenceRows {
		evidence = append(evidence, toPublicEvidence(&evidenceRows[i]))
	}

	subagents := make([]map[string]any, 0, len(subtaskRows))
	for _, row := range subtaskRows {
		item := map[string]any{
			"id":            row.TaskKey,
			"objective":     row.Objective,
			"status":        row.Status,
			"evidenceCount": row.EvidenceCount,
		}
		if row.Summary != nil {
			item["summary"] = row.Summary
		}
		if row.DurationMs != nil {
			item["durationMs"] = *row.DurationMs
		}
		subagents = append(subagents, item)
	}

	view := map[string]any{
		"id":             run.RunKey,
		"conversationId": run.ConversationID,
		"status":         run.Status,
		"complexity":     run.Complexity,
		"goal":           run.Goal,
		"answer":         derefStrOrEmpty(run.Answer),
		"plan":           parseJSONArrayOrDefault(run.PlanJSON),
		"loadedSkills":   parseStringArrayOrDefault(run.LoadedSkillsJSON),
		"activities":     activities,
		"subagents":      subagents,
		"evidence":       evidence,
		"metrics": map[string]any{
			"durationMs":    derefI32AsInt64(run.DurationMs),
			"toolCalls":     run.ToolCallCount,
			"evidenceCount": len(evidenceRows),
			"subAgentCount": len(subtaskRows),
			"iterations":    run.IterationCount,
		},
		"startedAt": run.StartedAt.UnixMilli(),
	}
	// 停止原因转成用户可读文案（stopMessage），内部策略名只留在 Debug 通道
	if run.StopReason != nil {
		view["stopReason"] = *run.StopReason
		if msg := describeStopReasonForUser(run.StopReason); msg != nil {
			view["stopMessage"] = msg
		}
	}
	if run.CompletedAt != nil {
		view["completedAt"] = run.CompletedAt.UnixMilli()
	}
	return view, nil
}

// loadAgentRunTrace Debug 视图：完整 Trace 事件 + token/latency，仅调试入口可访问。
func loadAgentRunTrace(ctx context.Context, runKey string, userID int64) (map[string]any, error) {
	run, err := scanAgentRun(dbPool().QueryRow(ctx,
		`SELECT `+agentRunColumns+` FROM petrichor_agent_run
		 WHERE run_key = $1 AND user_id = $2 LIMIT 1`, runKey, userID))
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, err
	}
	events, err := queryTraceEventsOrdered(ctx, runKey)
	if err != nil {
		return nil, err
	}

	eventMaps := make([]map[string]any, 0, len(events))
	for _, event := range events {
		eventMaps = append(eventMaps, map[string]any{
			"sequence":  event.Sequence,
			"type":      event.EventType,
			"toolId":    event.ToolID,
			"payload":   parseJSONMap(event.PayloadJSON),
			"createdAt": event.CreatedAt.UnixMilli(),
		})
	}

	runView := map[string]any{
		"id":              idStr(run.ID), // bigint ID 字符串化（TS 原样返回数字，这里按仓库约定收敛）
		"runKey":          run.RunKey,
		"conversationId":  run.ConversationID,
		"threadId":        derefI64OrNil(run.ThreadID),
		"userId":          idStr(run.UserID), // 同上
		"retryOfRunKey":   run.RetryOfRunKey,
		"model":           run.Model,
		"goal":            run.Goal,
		"complexity":      run.Complexity,
		"status":          run.Status,
		"stopReason":      run.StopReason,
		"answer":          run.Answer,
		"toolCallCount":   run.ToolCallCount,
		"iterationCount":  run.IterationCount,
		"delegationCount": run.DelegationCount,
		"inputTokens":     run.InputTokens,
		"outputTokens":    run.OutputTokens,
		"totalTokens":     run.TotalTokens,
		"durationMs":      run.DurationMs,
		"startedAt":       httpx.FormatISO(run.StartedAt),
		"routingHint":     parseJSONValuePtr(run.RoutingHintJSON),
		"plan":            parseJSONArrayOrDefault(run.PlanJSON),
		"metrics":         parseJSONMapOrDefault(run.MetricsJSON),
		"evaluation":      parseJSONValuePtr(run.EvalJSON),
	}
	if run.CompletedAt != nil {
		runView["completedAt"] = httpx.FormatISO(*run.CompletedAt)
	} else {
		runView["completedAt"] = nil
	}
	return map[string]any{"run": runView, "events": eventMaps}, nil
}

// toPublicEvidence 对照 events.ts 的 toPublicEvidence：relevance/confidence 落库为 0-100 整数，读时 /100。
func toPublicEvidence(row *agentEvidenceRow) map[string]any {
	title := ""
	if row.Title != nil {
		title = *row.Title
	} else {
		content := []rune(row.Content)
		if len(content) > 60 {
			content = content[:60]
		}
		title = string(content)
	}
	out := map[string]any{
		"id":     row.EvidenceKey,
		"source": row.Source,
		"title":  title,
	}
	if row.Content != "" {
		snippet := []rune(row.Content)
		if len(snippet) > 280 {
			snippet = snippet[:280]
		}
		out["snippet"] = string(snippet)
	}
	if row.URL != nil {
		out["url"] = *row.URL
	}
	metadata := parseJSONMap(row.MetadataJSON)
	metadataNodeKey := metadataString(metadata, "nodeKey")
	if metadataNodeKey != "" {
		out["nodeKey"] = metadataNodeKey
	}
	metadataArticleID := metadataString(metadata, "articleId")
	if metadataArticleID != "" {
		out["articleId"] = metadataArticleID
	}
	metadataKbID := metadataString(metadata, "knowledgeBaseId")
	if metadataKbID != "" {
		out["knowledgeBaseId"] = metadataKbID
	}
	if path, ok := metadata["path"].([]any); ok {
		out["path"] = path
	}
	if row.Relevance != nil {
		out["relevance"] = float64(*row.Relevance) / 100
	}
	if row.Confidence != nil {
		out["confidence"] = float64(*row.Confidence) / 100
	}
	return out
}

// ===== 宽松取值工具 =====

func trimSpaceStr(s string) string {
	b := []byte(s)
	start := 0
	end := len(b)
	for start < end {
		c := b[start]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			start++
			continue
		}
		break
	}
	for end > start {
		c := b[end-1]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			end--
			continue
		}
		break
	}
	return string(b[start:end])
}

func anyToStringOr(v any, fallback string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return fallback
}

func anyToFloatOr(v any, fallback int64) int64 {
	switch value := v.(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	default:
		return fallback
	}
}

func anyToStringArrayOr(v any) []any {
	if arr, ok := v.([]any); ok {
		return arr
	}
	return []any{}
}

func metadataString(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

func derefStrOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefI32AsInt64(v *int32) int64 {
	if v == nil {
		return 0
	}
	return int64(*v)
}

func derefI64OrNil(v *int64) any {
	if v == nil {
		return nil
	}
	return idStr(*v)
}

// parseJSONArrayOrDefault 对应 parseJson<T>(...) ?? []：坏值回落空数组。
func parseJSONArrayOrDefault(raw *string) any {
	if raw == nil {
		return []any{}
	}
	var v any
	if err := json.Unmarshal([]byte(*raw), &v); err != nil {
		return []any{}
	}
	return v
}

func parseStringArrayOrDefault(raw *string) any {
	if parsed, ok := parseJSONArrayOrDefault(raw).([]any); ok {
		return parsed
	}
	return []any{}
}

func parseJSONMapOrDefault(raw *string) map[string]any {
	if m := parseJSONMap(raw); m != nil {
		return m
	}
	return map[string]any{}
}

func parseJSONValuePtr(raw *string) any {
	if raw == nil || trimSpaceStr(*raw) == "" {
		return nil
	}
	var v any
	if err := json.Unmarshal([]byte(*raw), &v); err != nil {
		return nil
	}
	return v
}
