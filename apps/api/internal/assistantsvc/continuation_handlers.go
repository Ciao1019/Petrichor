package assistantsvc

import (
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	rt "petrichor/api/internal/assistantsvc/runtime"
	httpx "petrichor/api/internal/httpx"
)

func AssistantRunControlHandler(c *gin.Context) {
	var req struct {
		ThreadID reqFlexID `json:"threadId"`
		Mode     string    `json:"mode"`
		Text     string    `json:"text"`
	}
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if req.ThreadID.Int64() <= 0 || (req.Mode != "cancel" && req.Mode != "steer" && req.Mode != "follow_up") || (req.Mode != "cancel" && (req.Text == "" || runeLen(req.Text) > 4000 || rt.IsPromptInjectionAttempt(req.Text))) {
		httpx.ErrorJSON(c, 400, "运行控制参数无效")
		return
	}
	user := currentUserOf(c)
	query := `UPDATE petrichor_agent_continuation SET cancel_requested=true WHERE thread_id=$1 AND user_id=$2 AND status='running' AND lease_until>now()`
	args := []any{req.ThreadID.Int64(), user.ID}
	if req.Mode != "cancel" {
		query = `UPDATE petrichor_agent_continuation SET controls_json=controls_json || jsonb_build_array(jsonb_build_object('sequence',jsonb_array_length(controls_json)+1,'mode',$3::text,'text',$4::text))
		WHERE thread_id=$1 AND user_id=$2 AND status='running' AND lease_until>now() AND NOT cancel_requested AND jsonb_array_length(controls_json)<32`
		args = append(args, req.Mode, req.Text)
	}
	result, err := continuationDB().Exec(c.Request.Context(), query, args...)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if result.RowsAffected() != 1 {
		httpx.ErrorJSON(c, 409, "任务已经结束、正在停止或补充要求已达上限")
		return
	}
	httpx.OK(c, map[string]any{"accepted": true})
}

func AssistantRunRecoveryHandler(c *gin.Context) {
	var req struct {
		ThreadID reqFlexID `json:"threadId"`
	}
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	var raw []byte
	var running, completed bool
	err := continuationDB().QueryRow(c.Request.Context(), `SELECT payload_json,status='running' AND lease_until>now(),status='completed'
		FROM petrichor_agent_continuation WHERE thread_id=$1 AND user_id=$2`, req.ThreadID.Int64(), currentUserOf(c).ID).Scan(&raw, &running, &completed)
	if err == pgx.ErrNoRows {
		httpx.OK(c, map[string]any{"available": false, "running": false})
		return
	}
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	var payload continuationPayload
	if json.Unmarshal(raw, &payload) != nil {
		httpx.ErrorJSON(c, 500, "检查点不可用")
		return
	}
	uncertain := payload.Pending != nil && payload.Pending.SideEffect
	httpx.OK(c, map[string]any{"running": running, "available": !running && !completed && payload.State != nil && !uncertain, "needsReview": !running && !completed && uncertain})
}
