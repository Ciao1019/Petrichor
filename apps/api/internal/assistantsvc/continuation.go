package assistantsvc

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	rt "petrichor/api/internal/assistantsvc/runtime"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/piruntime"
)

var continuationDB = dbPool

// 每个对话保留最近一次可恢复任务；凭据、模型连接及系统角色不进入检查点。
type continuationPayload struct {
	Goal     string            `json:"goal"`
	Messages []json.RawMessage `json:"messages"`
	Focus    *assistantFocus   `json:"focus"`
	ModelID  int64             `json:"modelId"`
	State    *rt.AgentState    `json:"state,omitempty"`
	Pending  *rt.PendingTool   `json:"pending,omitempty"`
}

type continuationLease struct {
	threadID int64
	userID   int64
	runKey   string
	token    string
	payload  continuationPayload
}

func loadContinuation(ctx context.Context, userID, threadID int64) (*continuationPayload, string, error) {
	var raw []byte
	var key string
	var available bool
	err := continuationDB().QueryRow(ctx, `SELECT payload_json,run_key,status <> 'completed' AND (status <> 'running' OR lease_until < now())
		FROM petrichor_agent_continuation WHERE thread_id=$1 AND user_id=$2`, threadID, userID).Scan(&raw, &key, &available)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", httpx.NotFound("没有可恢复的任务")
	}
	if err != nil {
		return nil, "", err
	}
	if !available {
		return nil, "", httpx.Conflict("任务正在运行或已经完成")
	}
	var payload continuationPayload
	if json.Unmarshal(raw, &payload) != nil || payload.State == nil || len(payload.Messages) == 0 {
		return nil, "", httpx.Conflict("尚无可恢复检查点，请重新发送消息")
	}
	if payload.Pending != nil && payload.Pending.SideEffect {
		return nil, "", httpx.Conflict("上次写操作的结果尚未确认，请核实后重新发起任务，避免重复操作")
	}
	return &payload, key, nil
}

func acquireContinuation(ctx context.Context, userID, threadID int64, payload continuationPayload, previousKey string) (*continuationLease, error) {
	lease := &continuationLease{userID: userID, threadID: threadID, runKey: rt.NewRunID(), token: uuid.NewString(), payload: payload}
	raw, err := json.Marshal(payload)
	if err != nil || len(raw) > 4*1024*1024 {
		return nil, httpx.BadRequest("任务上下文过大")
	}
	result, err := continuationDB().Exec(ctx, `INSERT INTO petrichor_agent_continuation
		(thread_id,user_id,run_key,payload_json,status,lease_token,lease_until)
		VALUES ($1,$2,$3,$4::jsonb,'running',$5,now()+interval '60 seconds')
		ON CONFLICT (thread_id) DO UPDATE SET run_key=$3,payload_json=$4::jsonb,status='running',lease_token=$5,
		lease_until=now()+interval '60 seconds',cancel_requested=false,updated_at=now(),
		controls_json=CASE WHEN $6='' THEN '[]'::jsonb ELSE petrichor_agent_continuation.controls_json END
		WHERE petrichor_agent_continuation.user_id=$2
		AND (petrichor_agent_continuation.status<>'running' OR petrichor_agent_continuation.lease_until<now())
		AND ($6='' OR petrichor_agent_continuation.run_key=$6)`, threadID, userID, lease.runKey, string(raw), lease.token, previousKey)
	if err != nil {
		return nil, err
	}
	if result.RowsAffected() != 1 {
		return nil, httpx.Conflict("该对话已有任务正在运行，请等待或停止后再试")
	}
	return lease, nil
}

func (l *continuationLease) save(ctx context.Context, state *rt.AgentState, pending *rt.PendingTool) error {
	l.payload.State, l.payload.Pending = state, pending
	l.payload.Goal = state.Goal
	raw, err := json.Marshal(l.payload)
	if err != nil || len(raw) > 4*1024*1024 {
		return errors.New("检查点超过存储限制")
	}
	result, err := continuationDB().Exec(ctx, `UPDATE petrichor_agent_continuation SET payload_json=$1::jsonb,updated_at=now()
		WHERE thread_id=$2 AND user_id=$3 AND lease_token=$4 AND status='running' AND lease_until>now() AND NOT cancel_requested`,
		string(raw), l.threadID, l.userID, l.token)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return errors.New("任务租约已失效或已取消")
	}
	return nil
}

func (l *continuationLease) controls(ctx context.Context, after int64) ([]piruntime.Control, error) {
	var raw []byte
	err := continuationDB().QueryRow(ctx, `SELECT controls_json FROM petrichor_agent_continuation
		WHERE thread_id=$1 AND user_id=$2 AND lease_token=$3 AND NOT cancel_requested AND status='running' AND lease_until>now()`, l.threadID, l.userID, l.token).Scan(&raw)
	if err != nil {
		return nil, err
	}
	var controls []piruntime.Control
	if err := json.Unmarshal(raw, &controls); err != nil {
		return nil, err
	}
	out := []piruntime.Control{}
	for _, control := range controls {
		if control.Sequence > after {
			out = append(out, control)
		}
	}
	return out, nil
}

func (l *continuationLease) heartbeat(ctx context.Context, cancel context.CancelFunc) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			updateCtx, done := context.WithTimeout(ctx, 3*time.Second)
			result, err := continuationDB().Exec(updateCtx, `UPDATE petrichor_agent_continuation SET lease_until=now()+interval '60 seconds'
				WHERE thread_id=$1 AND user_id=$2 AND lease_token=$3 AND status='running' AND lease_until>now() AND NOT cancel_requested`, l.threadID, l.userID, l.token)
			done()
			if err != nil || result.RowsAffected() != 1 {
				cancel()
				return
			}
		}
	}
}

func (l *continuationLease) finish(ctx context.Context, complete bool) {
	seq := int64(0)
	if l.payload.State != nil {
		seq = l.payload.State.ControlSequence
	}
	_, err := continuationDB().Exec(ctx, `UPDATE petrichor_agent_continuation SET
		status=CASE WHEN $4 AND jsonb_array_length(controls_json)<=$5 THEN 'completed' ELSE 'interrupted' END,
		lease_until=now(),updated_at=now() WHERE thread_id=$1 AND user_id=$2 AND lease_token=$3 AND status='running'`,
		l.threadID, l.userID, l.token, complete, seq)
	if err != nil {
		logStoreError("finishContinuation", err, "runKey", l.runKey)
	}
}

func (l *continuationLease) owns(ctx context.Context) bool {
	var owned bool
	err := continuationDB().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM petrichor_agent_continuation WHERE thread_id=$1 AND user_id=$2 AND lease_token=$3)`, l.threadID, l.userID, l.token).Scan(&owned)
	return err == nil && owned
}
