// agentrun.go 对照 agent-run-handlers.ts 与 agent-runtime/store.ts：
// Run 查询接口（V2 表 petrichor_agent_run / trace_event / evidence / subtask）。
// 读路径 fail-open：查询失败退化为「不存在/空列表」，真实原因进结构化日志。
package assistantsvc

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const agentRunColumns = `id, run_key, conversation_id, thread_id, user_id, retry_of_run_key,
	model, goal, complexity, status, stop_reason, answer, routing_hint_json, plan_json,
	loaded_skills_json, metrics_json, eval_json, tool_call_count, iteration_count,
	delegation_count, input_tokens, output_tokens, total_tokens, duration_ms,
	started_at, completed_at`

type agentRunRecord struct {
	ID               int64
	RunKey           string
	ConversationID   string
	ThreadID         *int64
	UserID           int64
	RetryOfRunKey    *string
	Model            string
	Goal             string
	Complexity       string
	Status           string
	StopReason       *string
	Answer           *string
	RoutingHintJSON  *string
	PlanJSON         *string
	LoadedSkillsJSON *string
	MetricsJSON      *string
	EvalJSON         *string
	ToolCallCount    int32
	IterationCount   int32
	DelegationCount  int32
	InputTokens      int32
	OutputTokens     int32
	TotalTokens      int32
	DurationMs       *int32
	StartedAt        time.Time
	CompletedAt      *time.Time
}

func scanAgentRun(row interface{ Scan(dest ...any) error }) (*agentRunRecord, error) {
	var r agentRunRecord
	if err := row.Scan(&r.ID, &r.RunKey, &r.ConversationID, &r.ThreadID, &r.UserID,
		&r.RetryOfRunKey, &r.Model, &r.Goal, &r.Complexity, &r.Status, &r.StopReason,
		&r.Answer, &r.RoutingHintJSON, &r.PlanJSON, &r.LoadedSkillsJSON, &r.MetricsJSON,
		&r.EvalJSON, &r.ToolCallCount, &r.IterationCount, &r.DelegationCount,
		&r.InputTokens, &r.OutputTokens, &r.TotalTokens, &r.DurationMs,
		&r.StartedAt, &r.CompletedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

type agentTraceEventRow struct {
	ID          int64
	RunKey      string
	Sequence    int32
	EventType   string
	PayloadJSON *string
	ToolID      *string
	CreatedAt   time.Time
}

type agentEvidenceRow struct {
	ID           int64
	RunKey       string
	EvidenceKey  string
	Source       string
	Title        *string
	Content      string
	SourceID     *string
	URL          *string
	Relevance    *int32
	Confidence   *int32
	MetadataJSON *string
	CreatedAt    time.Time
}

type agentSubtaskRow struct {
	ID            int64
	RunKey        string
	TaskKey       string
	Objective     string
	Status        string
	Summary       *string
	Depth         int32
	EvidenceCount int32
	DurationMs    *int32
	CreatedAt     time.Time
}

func parseJSONMap(raw *string) map[string]any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(*raw), &m); err != nil {
		return nil
	}
	return m
}

// describeStopReasonForUser 面向普通用户的停止文案：不暴露内部策略名（§162.26）。
func describeStopReasonForUser(reason *string) any {
	if reason == nil {
		return nil
	}
	switch *reason {
	case "goal_completed", "enough_evidence":
		return nil
	case "cancelled":
		return "已停止。"
	case "permission_denied":
		return "当前账号没有执行该操作的权限，任务已停止。"
	case "fatal_error":
		return "执行过程中出现问题，任务已停止。"
	default:
		return "任务执行已停止，因为暂时无法获得更多有效信息。"
	}
}

// isAssistantOperator 对照 operator-gate.ts：当前实现 = SUPER_ADMIN。
func isAssistantOperator(systemRole string) bool { return systemRole == "SUPER_ADMIN" }

// readAgentDebugFlag 对应 readAgentFeatureFlags().debug 的 envFlag 语义。
func readAgentDebugFlag() bool {
	raw := os.Getenv("AGENT_DEBUG")
	if raw == "" {
		return false
	}
	return raw == "1" || strings.EqualFold(raw, "true")
}

// logStoreError 对照 store.ts 的 logStoreError：结构化日志（fail-open 的排障入口）。
func logStoreError(scope string, err error, fields ...any) {
	slog.Error("agent-runtime.store."+scope, append([]any{"err", err.Error()}, fields...)...)
}

func isNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
