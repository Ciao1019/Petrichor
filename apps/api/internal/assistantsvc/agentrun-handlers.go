// agentrun-handlers.go Run 查询 HTTP 层与读取逻辑（对照 agent-run-handlers.ts + store.ts 读取段）。
package assistantsvc

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
)

func readRunIDRequest(c *gin.Context) (string, bool) {
	var req struct {
		RunID string `json:"runId"`
	}
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return "", false
	}
	runID := trimSpaceStr(req.RunID)
	if runID == "" || runeLen(runID) > 64 {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return "", false
	}
	return runID, true
}

// AgentRunDetailHandler POST /api/assistant/agent-run/detail。
func AgentRunDetailHandler(c *gin.Context) {
	runID, ok := readRunIDRequest(c)
	if !ok {
		return
	}
	user := currentUserOf(c)
	view, err := loadAgentRunView(c.Request.Context(), runID, user.ID)
	if err != nil {
		logStoreError("loadRunView", err, "runId", runID)
		view = nil
	}
	if view == nil {
		httpx.ErrorJSON(c, 404, "Agent Run 不存在")
		return
	}
	httpx.OK(c, view)
}

// AgentRunListHandler POST /api/assistant/agent-run/list。
func AgentRunListHandler(c *gin.Context) {
	var req struct {
		ConversationID string `json:"conversationId"`
		Limit          *int64 `json:"limit"`
	}
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	conversationID := trimSpaceStr(req.ConversationID)
	if conversationID == "" || runeLen(conversationID) > 64 ||
		(req.Limit != nil && (*req.Limit < 1 || *req.Limit > 100)) {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	limit := int64(50)
	if req.Limit != nil {
		limit = *req.Limit
	}
	user := currentUserOf(c)
	runs, err := listAgentRunsForConversation(c.Request.Context(), conversationID, user.ID, limit)
	if err != nil {
		logStoreError("listRuns", err, "conversationId", conversationID)
		runs = []map[string]any{}
	}
	httpx.OK(c, map[string]any{"runs": runs})
}

// AgentRunTraceHandler POST /api/assistant/agent-run/trace。Debug UI 用，需操作员或 AGENT_DEBUG。
func AgentRunTraceHandler(c *gin.Context) {
	user := currentUserOf(c)
	if !isAssistantOperator(user.SystemRole) && !readAgentDebugFlag() {
		httpx.ErrorJSON(c, 403, "agent_debug_disabled")
		return
	}
	runID, ok := readRunIDRequest(c)
	if !ok {
		return
	}
	trace, err := loadAgentRunTrace(c.Request.Context(), runID, user.ID)
	if err != nil {
		logStoreError("loadRunTrace", err, "runId", runID)
		trace = nil
	}
	if trace == nil {
		httpx.ErrorJSON(c, 404, "Agent Run 不存在")
		return
	}
	httpx.OK(c, trace)
}

// ===== 查询 =====

func listAgentRunsForConversation(ctx context.Context, conversationID string, userID, limit int64) ([]map[string]any, error) {
	rows, err := dbPool().Query(ctx,
		`SELECT run_key, status, complexity, stop_reason, started_at, completed_at
		 FROM petrichor_agent_run
		 WHERE conversation_id = $1 AND user_id = $2
		 ORDER BY started_at DESC
		 LIMIT $3`, conversationID, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []map[string]any{}
	for rows.Next() {
		var (
			runKey, status, complexity string
			stopReason                 *string
			startedAt                  time.Time
			completedAt                *time.Time
		)
		if err := rows.Scan(&runKey, &status, &complexity, &stopReason, &startedAt, &completedAt); err != nil {
			return nil, err
		}
		var completedAtValue any
		if completedAt != nil {
			completedAtValue = httpx.FormatISO(*completedAt)
		}
		runs = append(runs, map[string]any{
			"runKey":      runKey,
			"status":      status,
			"complexity":  complexity,
			"stopReason":  stopReason,
			"startedAt":   httpx.FormatISO(startedAt),
			"completedAt": completedAtValue,
		})
	}
	return runs, rows.Err()
}

func queryTraceEventsOrdered(ctx context.Context, runKey string) ([]agentTraceEventRow, error) {
	rows, err := dbPool().Query(ctx,
		`SELECT id, run_key, sequence, event_type, payload_json, tool_id, created_at
		 FROM petrichor_agent_trace_event WHERE run_key = $1 ORDER BY sequence ASC`, runKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []agentTraceEventRow
	for rows.Next() {
		var e agentTraceEventRow
		if err := rows.Scan(&e.ID, &e.RunKey, &e.Sequence, &e.EventType, &e.PayloadJSON, &e.ToolID, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func queryEvidenceOrdered(ctx context.Context, runKey string) ([]agentEvidenceRow, error) {
	rows, err := dbPool().Query(ctx,
		`SELECT id, run_key, evidence_key, source, title, content, source_id, url,
			relevance, confidence, metadata_json, created_at
		 FROM petrichor_agent_evidence WHERE run_key = $1 ORDER BY created_at ASC`, runKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []agentEvidenceRow
	for rows.Next() {
		var e agentEvidenceRow
		if err := rows.Scan(&e.ID, &e.RunKey, &e.EvidenceKey, &e.Source, &e.Title, &e.Content,
			&e.SourceID, &e.URL, &e.Relevance, &e.Confidence, &e.MetadataJSON, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func querySubtasksOrdered(ctx context.Context, runKey string) ([]agentSubtaskRow, error) {
	rows, err := dbPool().Query(ctx,
		`SELECT id, run_key, task_key, objective, status, summary, depth, evidence_count,
			duration_ms, created_at
		 FROM petrichor_agent_subtask WHERE run_key = $1 ORDER BY created_at ASC`, runKey)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []agentSubtaskRow
	for rows.Next() {
		var s agentSubtaskRow
		if err := rows.Scan(&s.ID, &s.RunKey, &s.TaskKey, &s.Objective, &s.Status, &s.Summary,
			&s.Depth, &s.EvidenceCount, &s.DurationMs, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}
