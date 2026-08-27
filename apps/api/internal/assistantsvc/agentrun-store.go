package assistantsvc

import (
	"context"
	"encoding/json"
	"math"
	"time"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

// agentRunCreateInput 是 V2 Runtime 的可恢复 Run 头；与 assistant_run（HTTP 请求审计）分表。
type agentRunCreateInput struct {
	RunKey         string
	ConversationID string
	ThreadID       int64
	UserID         int64
	RetryOfRunKey  string
	Model          string
	Goal           string
	Complexity     rt.TaskComplexity
}

func createAgentRunRecordBestEffort(ctx context.Context, input agentRunCreateInput) {
	var retry any
	if input.RetryOfRunKey != "" {
		retry = input.RetryOfRunKey
	}
	_, err := dbPool().Exec(ctx, `
		INSERT INTO petrichor_agent_run
			(run_key, conversation_id, thread_id, user_id, retry_of_run_key,
			 model, goal, complexity, status, started_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running',$9)
		ON CONFLICT (run_key) DO NOTHING`,
		input.RunKey, input.ConversationID, input.ThreadID, input.UserID, retry,
		input.Model, truncateStoreText(input.Goal, 4_000), storeText(input.Complexity), time.Now())
	if err != nil {
		logStoreError("createRun", err, "runKey", input.RunKey)
	}
}

// persistAgentRunBestEffort 对齐 TS persistAgentRun：Run、Trace、Evidence、Subtask
// 各自 fail-open；任何审计表故障都不能让已经生成的回答失败。
func persistAgentRunBestEffort(ctx context.Context, result *rt.RunResult) {
	if result == nil || result.State == nil || result.Trace == nil {
		return
	}
	if err := finishAgentRunRecord(ctx, result); err != nil {
		logStoreError("finishRun", err, "runKey", result.RunID)
	}
	if err := persistAgentTrace(ctx, result.Trace); err != nil {
		logStoreError("persistTrace", err, "runKey", result.RunID)
	}
	if err := persistAgentEvidence(ctx, result.RunID, result.State.Evidence); err != nil {
		logStoreError("persistEvidence", err, "runKey", result.RunID)
	}
	if err := persistAgentSubtasks(ctx, result.RunID, result.Trace.Delegations); err != nil {
		logStoreError("persistSubtasks", err, "runKey", result.RunID)
	}
}

func finishAgentRunRecord(ctx context.Context, result *rt.RunResult) error {
	state := result.State
	trace := result.Trace
	routingJSON := nullableJSON(trace.RoutingHint)
	planJSON := nullableJSONSlice(state.Plan)
	loadedJSON := nullableJSONSlice(state.LoadedSkills)
	metricsJSON := nullableJSON(map[string]any{"latency": trace.Latency})
	evalJSON := nullableJSON(result.Evaluation)
	completedAt := time.Now()
	_, err := dbPool().Exec(ctx, `
		UPDATE petrichor_agent_run SET
			status=$1, stop_reason=$2, answer=$3, complexity=$4,
			routing_hint_json=$5, plan_json=$6, loaded_skills_json=$7,
			metrics_json=$8, eval_json=$9, tool_call_count=$10,
			iteration_count=$11, delegation_count=$12, input_tokens=$13,
			output_tokens=$14, total_tokens=$15, duration_ms=$16, completed_at=$17
		WHERE run_key=$18`,
		storeText(state.Status), nullableString(storeText(state.StopReason)), truncateStoreText(result.Answer, 100_000), storeText(state.Complexity),
		routingJSON, planJSON, loadedJSON, metricsJSON, evalJSON,
		state.ToolCallCount, state.Iteration, state.DelegationCount,
		state.TokenUsage.Input, state.TokenUsage.Output, state.TokenUsage.Total,
		trace.TotalLatencyMs, completedAt, result.RunID)
	return err
}

func persistAgentTrace(ctx context.Context, trace *rt.AgentTrace) error {
	if trace == nil {
		return nil
	}
	sequence := 0
	for _, event := range trace.Steps {
		sequence = event.Sequence
		payload, _ := json.Marshal(event.Payload)
		toolID := tracePayloadToolID(event.Payload)
		if _, err := dbPool().Exec(ctx, `
			INSERT INTO petrichor_agent_trace_event
				(run_key, sequence, event_type, payload_json, tool_id, created_at)
			VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (run_key, sequence) DO NOTHING`,
			trace.RunID, event.Sequence, event.Type, string(payload), nullableString(toolID), time.UnixMilli(event.CreatedAt)); err != nil {
			return err
		}
	}
	for _, call := range trace.ToolCalls {
		sequence++
		payload, _ := json.Marshal(call)
		eventType := "error"
		if call.OK {
			eventType = "tool_result"
		}
		if _, err := dbPool().Exec(ctx, `
			INSERT INTO petrichor_agent_trace_event
				(run_key, sequence, event_type, payload_json, tool_id, created_at)
			VALUES ($1,$2,$3,$4,$5,$6)
			ON CONFLICT (run_key, sequence) DO NOTHING`,
			trace.RunID, sequence, eventType, string(payload), call.ToolID, time.UnixMilli(call.StartedAt)); err != nil {
			return err
		}
	}
	return nil
}

func persistAgentEvidence(ctx context.Context, runKey string, evidence []rt.AgentEvidence) error {
	for _, item := range evidence {
		metadata, _ := json.Marshal(item.Metadata)
		if _, err := dbPool().Exec(ctx, `
			INSERT INTO petrichor_agent_evidence
				(run_key, evidence_key, source, title, content, source_id, url,
				 relevance, confidence, metadata_json, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			ON CONFLICT (run_key, evidence_key) DO NOTHING`,
			runKey, item.ID, storeText(item.Source), nullableString(item.Title), truncateStoreText(item.Content, 20_000),
			nullableString(item.SourceID), nullableString(item.URL), scorePercent(item.Relevance),
			scorePercent(item.Confidence), nullableJSONString(metadata), time.UnixMilli(item.CreatedAt)); err != nil {
			return err
		}
	}
	return nil
}

func persistAgentSubtasks(ctx context.Context, runKey string, subtasks []rt.AgentDelegationTrace) error {
	for _, item := range subtasks {
		if _, err := dbPool().Exec(ctx, `
			INSERT INTO petrichor_agent_subtask
				(run_key, task_key, objective, status, depth, evidence_count, duration_ms, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
			ON CONFLICT (run_key, task_key) DO NOTHING`,
			runKey, item.TaskID, truncateStoreText(item.Objective, 2_000), item.Status,
			item.Depth, item.EvidenceCount, item.DurationMs, time.Now()); err != nil {
			return err
		}
	}
	return nil
}

func tracePayloadToolID(payload map[string]any) string {
	if value, ok := payload["toolId"].(string); ok {
		return value
	}
	return ""
}

func nullableJSON(value any) any {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil || string(raw) == "null" {
		return nil
	}
	return string(raw)
}

func nullableJSONSlice(value any) any {
	raw, err := json.Marshal(value)
	if err != nil || string(raw) == "null" || string(raw) == "[]" {
		return nil
	}
	return string(raw)
}

func nullableJSONString(raw []byte) any {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == "{}" {
		return nil
	}
	return string(raw)
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// storeText 在数据库边界把底层为 string 的领域枚举降为原生 string。
// pgx 的 QueryExecModeExec 不会为未注册的自定义字符串类型推断编码器。
func storeText[T ~string](value T) string {
	return string(value)
}

func scorePercent(value *float64) any {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return nil
	}
	score := *value
	if score < 0 {
		score = 0
	}
	if score > 1 {
		score = 1
	}
	return int(math.Round(score * 100))
}

func truncateStoreText(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
