// threads.go 对照 thread-handlers.ts / thread-logic.ts / plan-store.ts：
// thread create/detail/list/delete/delete-many 与 plan/patch。
package assistantsvc

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	httpx "petrichor/api/internal/httpx"
)

// ===== 行结构 =====

type assistantThreadRow struct {
	ID        int64
	UserID    int64
	Title     string
	FocusJSON *string
	CreatedAt time.Time
	UpdatedAt time.Time
}

const assistantThreadColumns = `id, user_id, title, focus_json, created_at, updated_at`

func scanAssistantThread(row interface{ Scan(dest ...any) error }) (*assistantThreadRow, error) {
	var r assistantThreadRow
	if err := row.Scan(&r.ID, &r.UserID, &r.Title, &r.FocusJSON, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

type assistantMessageRow struct {
	ID          int64
	ThreadID    int64
	Role        string
	ContentJSON *string
	CreatedAt   time.Time
}

const assistantMessageColumns = `id, thread_id, role, content_json, created_at`

type assistantPlanRow struct {
	ID          int64
	ThreadID    int64
	UserID      int64
	PlanKey     string
	Title       string
	Description *string
	TodosJSON   string
	Status      string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const assistantPlanColumns = `id, thread_id, user_id, plan_key, title, description, todos_json,
	status, created_at, updated_at`

// ===== 响应形状 =====

// toAssistantThreadResponse 对应 toAssistantThreadResponse：bigint ID 字符串化、时间 ISO。
func toAssistantThreadResponse(t *assistantThreadRow) map[string]any {
	return map[string]any{
		"id":        idStr(t.ID),
		"title":     t.Title,
		"focus":     parseJSONValue(t.FocusJSON),
		"createdAt": httpx.FormatISO(t.CreatedAt),
		"updatedAt": httpx.FormatISO(t.UpdatedAt),
	}
}

// ===== 逻辑 =====

func loadAssistantThreadOrThrow(ctx context.Context, userID, threadID int64) (*assistantThreadRow, error) {
	t, err := scanAssistantThread(dbPool().QueryRow(ctx,
		`SELECT `+assistantThreadColumns+` FROM petrichor_assistant_thread
		 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL LIMIT 1`, threadID, userID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, httpx.NotFound("对话不存在")
		}
		return nil, err
	}
	return t, nil
}

func createAssistantThread(ctx context.Context, userID int64, title *string, focus *assistantFocus) (*assistantThreadRow, error) {
	now := time.Now()
	titleValue := summarizeThreadTitle(derefOrEmpty(title))
	var focusJSON *string
	if focus != nil {
		focusJSON = marshalJSONString(focus)
	}
	var createdID int64
	err := dbPool().QueryRow(ctx,
		`INSERT INTO petrichor_assistant_thread (user_id, title, focus_json, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5) RETURNING id`,
		userID, titleValue, focusJSON, now, now).Scan(&createdID)
	if err != nil {
		return nil, err
	}
	return loadAssistantThreadOrThrow(ctx, userID, createdID)
}

func ensureAssistantThread(ctx context.Context, userID, threadID int64, hasThreadID bool, title string, focus *assistantFocus) (*assistantThreadRow, error) {
	if hasThreadID {
		return loadAssistantThreadOrThrow(ctx, userID, threadID)
	}
	return createAssistantThread(ctx, userID, &title, focus)
}

// persistAssistantMessage 写入消息并触碰线程 updatedAt；user 消息带标题候选时同步改题。
func persistAssistantMessage(ctx context.Context, userID, threadID int64, role string, content any, titleCandidate string) error {
	p := dbPool()
	now := time.Now()
	raw := marshalJSONString(content)
	if _, err := p.Exec(ctx,
		`INSERT INTO petrichor_assistant_message (thread_id, role, content_json, created_at)
		 VALUES ($1, $2, $3, $4)`, threadID, role, raw, now); err != nil {
		return err
	}
	if role == "user" && strings.TrimSpace(titleCandidate) != "" {
		_, err := p.Exec(ctx,
			`UPDATE petrichor_assistant_thread SET updated_at = $1, title = $2
			 WHERE id = $3 AND user_id = $4`, now, summarizeThreadTitle(titleCandidate), threadID, userID)
		return err
	}
	_, err := p.Exec(ctx,
		`UPDATE petrichor_assistant_thread SET updated_at = $1
		 WHERE id = $2 AND user_id = $3`, now, threadID, userID)
	return err
}

// truncateAssistantThreadMessages 编辑重提：按时间序只保留前 keepCount 条（线性截断，无分支）。
func truncateAssistantThreadMessages(ctx context.Context, threadID int64, keepCount int) (int, error) {
	keep := keepCount
	if keep < 0 {
		keep = 0
	}
	rows, err := dbPool().Query(ctx,
		`SELECT id FROM petrichor_assistant_message WHERE thread_id = $1
		 ORDER BY created_at ASC, id ASC`, threadID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return 0, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if keep >= len(ids) {
		return 0, nil
	}
	toDelete := ids[keep:]
	if _, err := dbPool().Exec(ctx,
		`DELETE FROM petrichor_assistant_message WHERE id = ANY($1)`, toDelete); err != nil {
		return 0, err
	}
	return len(toDelete), nil
}

func listAssistantThreads(ctx context.Context, userID int64, cursor *int64, limit *int64, q *string) (map[string]any, error) {
	limitValue := int64(30)
	if limit != nil && *limit > 0 && *limit <= 100 {
		limitValue = *limit
	}
	offset := int64(0)
	if cursor != nil && *cursor > 0 {
		offset = *cursor
	}
	where := `WHERE user_id = $1 AND deleted_at IS NULL`
	args := []any{userID}
	if keyword := strings.TrimSpace(derefOrEmpty(q)); keyword != "" {
		var b strings.Builder
		for _, r := range keyword {
			switch r {
			case '\\', '%', '_':
				b.WriteRune('\\')
			}
			b.WriteRune(r)
		}
		args = append(args, "%"+b.String()+"%")
		where += ` AND title LIKE $` + strconv.Itoa(len(args))
	}
	rows, err := dbPool().Query(ctx,
		`SELECT `+assistantThreadColumns+` FROM petrichor_assistant_thread `+where+`
		 ORDER BY updated_at DESC, id DESC LIMIT $`+strconv.Itoa(len(args)+1)+` OFFSET $`+strconv.Itoa(len(args)+2),
		append(args, limitValue+1, offset)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []*assistantThreadRow
	for rows.Next() {
		t, err := scanAssistantThread(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	hasMore := int64(len(list)) > limitValue
	if hasMore {
		list = list[:limitValue]
	}
	items := make([]map[string]any, 0, len(list))
	for _, t := range list {
		items = append(items, toAssistantThreadResponse(t))
	}
	var nextCursor any
	if hasMore {
		nextCursor = offset + limitValue
	}
	return map[string]any{"items": items, "nextCursor": nextCursor}, nil
}

func getAssistantThreadDetail(ctx context.Context, userID, threadID int64) (map[string]any, error) {
	thread, err := loadAssistantThreadOrThrow(ctx, userID, threadID)
	if err != nil {
		return nil, err
	}
	limit := int64(assistantThreadDetailMessageLimit)
	// 取最近 N 条再按时间正序返回，避免长线程全量 hydrate
	rows, err := dbPool().Query(ctx,
		`SELECT `+assistantMessageColumns+` FROM petrichor_assistant_message
		 WHERE thread_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, thread.ID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var recent []*assistantMessageRow
	for rows.Next() {
		var m assistantMessageRow
		if err := rows.Scan(&m.ID, &m.ThreadID, &m.Role, &m.ContentJSON, &m.CreatedAt); err != nil {
			return nil, err
		}
		recent = append(recent, &m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	messages := make([]map[string]any, 0, len(recent))
	for i := len(recent) - 1; i >= 0; i-- {
		m := recent[i]
		messages = append(messages, map[string]any{
			"id":        idStr(m.ID),
			"role":      m.Role,
			"content":   parseJSONValue(m.ContentJSON),
			"createdAt": httpx.FormatISO(m.CreatedAt),
		})
	}
	plans, err := listActiveAssistantPlans(ctx, userID, thread.ID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"thread":    toAssistantThreadResponse(thread),
		"messages":  messages,
		"plans":     plans,
		"truncated": int64(len(recent)) >= limit,
	}, nil
}

func softDeleteAssistantThread(ctx context.Context, userID, threadID int64) (map[string]any, error) {
	thread, err := loadAssistantThreadOrThrow(ctx, userID, threadID)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	if _, err := dbPool().Exec(ctx,
		`UPDATE petrichor_assistant_thread SET deleted_at = $1, updated_at = $2 WHERE id = $3`,
		now, now, thread.ID); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true}, nil
}

func softDeleteAssistantThreads(ctx context.Context, userID int64, threadIDs []int64) (map[string]any, error) {
	if len(threadIDs) == 0 {
		return map[string]any{"deleted": 0}, nil
	}
	unique := dedupeInt64(threadIDs)
	now := time.Now()
	tag, err := dbPool().Exec(ctx,
		`UPDATE petrichor_assistant_thread SET deleted_at = $1, updated_at = $2
		 WHERE user_id = $3 AND id = ANY($4) AND deleted_at IS NULL`, now, now, userID, unique)
	if err != nil {
		return nil, err
	}
	return map[string]any{"deleted": tag.RowsAffected()}, nil
}

// ===== Plan 持久化（plan-store.ts）=====

type planTodo struct {
	ID          string  `json:"id"`
	Label       string  `json:"label"`
	Status      string  `json:"status"`
	Description *string `json:"description,omitempty"`
}

type serializablePlan struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description *string    `json:"description,omitempty"`
	Todos       []planTodo `json:"todos"`
}

var planTodoStatuses = map[string]bool{
	"pending": true, "in_progress": true, "completed": true, "cancelled": true,
}

// planRecordToSerializable 对应 planRecordToSerializable：数据损坏返回 nil（调用方报 400）。
func planRecordToSerializable(row *assistantPlanRow) *serializablePlan {
	var todos []planTodo
	if err := json.Unmarshal([]byte(row.TodosJSON), &todos); err != nil {
		return nil
	}
	if row.Title == "" || len(todos) == 0 {
		return nil
	}
	seen := map[string]bool{}
	for i := range todos {
		todo := &todos[i]
		if todo.ID == "" || todo.Label == "" || !planTodoStatuses[todo.Status] {
			return nil
		}
		if seen[todo.ID] {
			return nil
		}
		seen[todo.ID] = true
	}
	return &serializablePlan{ID: row.PlanKey, Title: row.Title, Description: row.Description, Todos: todos}
}

func upsertAssistantPlan(ctx context.Context, userID, threadID int64, plan *serializablePlan) error {
	now := time.Now()
	todosJSON := marshalJSONString(plan.Todos)
	_, err := dbPool().Exec(ctx,
		`INSERT INTO petrichor_assistant_plan
			(thread_id, user_id, plan_key, title, description, todos_json, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
		 ON CONFLICT (thread_id, plan_key) DO UPDATE SET
			user_id = EXCLUDED.user_id,
			title = EXCLUDED.title,
			description = EXCLUDED.description,
			todos_json = EXCLUDED.todos_json,
			status = 'active',
			updated_at = EXCLUDED.updated_at`,
		threadID, userID, plan.ID, plan.Title, plan.Description, todosJSON, now, now)
	return err
}

func patchAssistantPlanTodo(ctx context.Context, userID, threadID int64, planID, todoID, status string) (*serializablePlan, error) {
	row, err := scanPlanRow(dbPool().QueryRow(ctx,
		`SELECT `+assistantPlanColumns+` FROM petrichor_assistant_plan
		 WHERE thread_id = $1 AND user_id = $2 AND plan_key = $3 AND status = 'active'
		 LIMIT 1`, threadID, userID, planID))
	if err != nil {
		return nil, httpx.NotFound("计划不存在")
	}
	plan := planRecordToSerializable(row)
	if plan == nil {
		return nil, httpx.BadRequest("计划数据损坏")
	}
	found := false
	todos := make([]planTodo, 0, len(plan.Todos))
	for _, todo := range plan.Todos {
		if todo.ID == todoID {
			todo.Status = status
			found = true
		}
		todos = append(todos, todo)
	}
	if !found {
		return nil, httpx.NotFound("步骤不存在")
	}
	next := &serializablePlan{ID: plan.ID, Title: plan.Title, Description: plan.Description, Todos: todos}
	if err := upsertAssistantPlan(ctx, userID, threadID, next); err != nil {
		return nil, err
	}
	return next, nil
}

func listActiveAssistantPlans(ctx context.Context, userID, threadID int64) ([]map[string]any, error) {
	rows, err := dbPool().Query(ctx,
		`SELECT `+assistantPlanColumns+` FROM petrichor_assistant_plan
		 WHERE thread_id = $1 AND user_id = $2 AND status = 'active'
		 ORDER BY updated_at DESC, id DESC`, threadID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	plans := []map[string]any{}
	for rows.Next() {
		row, err := scanPlanRow(rows)
		if err != nil {
			return nil, err
		}
		if plan := planRecordToSerializable(row); plan != nil {
			plans = append(plans, planToMap(plan))
		}
	}
	return plans, rows.Err()
}

func scanPlanRow(row interface{ Scan(dest ...any) error }) (*assistantPlanRow, error) {
	var r assistantPlanRow
	if err := row.Scan(&r.ID, &r.ThreadID, &r.UserID, &r.PlanKey, &r.Title, &r.Description,
		&r.TodosJSON, &r.Status, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

func planToMap(p *serializablePlan) map[string]any {
	out := map[string]any{
		"id":    p.ID,
		"title": p.Title,
		"todos": p.Todos,
	}
	if p.Description != nil {
		out["description"] = p.Description
	}
	return out
}

// ===== HTTP 层 =====

type threadCreateRequest struct {
	Title *string         `json:"title"`
	Focus json.RawMessage `json:"focus"`
}

// AssistantThreadCreateHandler POST /api/assistant/thread/create。
func AssistantThreadCreateHandler(c *gin.Context) {
	var req threadCreateRequest
	// TS：readJson 失败回落 {}，create 允许空 body
	if err := readBodyLenient(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if req.Title != nil && runeLen(*req.Title) > 120 {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	focus, err := parseFocusInput(req.Focus)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := currentUserOf(c)
	ctx := c.Request.Context()
	if err := assertFocusOwnership(ctx, user.ID, focus); err != nil {
		httpx.HandleError(c, err)
		return
	}
	thread, err := createAssistantThread(ctx, user.ID, req.Title, focus)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, map[string]any{"thread": toAssistantThreadResponse(thread)})
}

// AssistantThreadDetailHandler POST /api/assistant/thread/detail。
func AssistantThreadDetailHandler(c *gin.Context) {
	var req struct {
		ThreadID reqFlexID `json:"threadId"`
	}
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if req.ThreadID.Int64() <= 0 {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	detail, err := getAssistantThreadDetail(c.Request.Context(), currentUserOf(c).ID, req.ThreadID.Int64())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, detail)
}

type assistantThreadListRequest struct {
	Cursor *int64  `json:"cursor"`
	Limit  *int64  `json:"limit"`
	Q      *string `json:"q"`
}

// AssistantThreadListHandler POST /api/assistant/thread/list。
func AssistantThreadListHandler(c *gin.Context) {
	var req assistantThreadListRequest
	// TS：readJson 失败回落 {}，list 允许空 body
	if err := readBodyLenient(c, &req); err != nil {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	if (req.Cursor != nil && *req.Cursor < 0) ||
		(req.Limit != nil && (*req.Limit <= 0 || *req.Limit > 100)) ||
		(req.Q != nil && runeLen(strings.TrimSpace(*req.Q)) > 120) {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	result, err := listAssistantThreads(c.Request.Context(), currentUserOf(c).ID, req.Cursor, req.Limit, req.Q)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AssistantThreadDeleteHandler POST /api/assistant/thread/delete。
func AssistantThreadDeleteHandler(c *gin.Context) {
	var req struct {
		ThreadID reqFlexID `json:"threadId"`
	}
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if req.ThreadID.Int64() <= 0 {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	result, err := softDeleteAssistantThread(c.Request.Context(), currentUserOf(c).ID, req.ThreadID.Int64())
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AssistantThreadDeleteManyHandler POST /api/assistant/thread/delete-many。
func AssistantThreadDeleteManyHandler(c *gin.Context) {
	var req struct {
		ThreadIDs []reqFlexID `json:"threadIds"`
	}
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	if len(req.ThreadIDs) < 1 || len(req.ThreadIDs) > 200 {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	ids := make([]int64, 0, len(req.ThreadIDs))
	for _, v := range req.ThreadIDs {
		ids = append(ids, v.Int64())
	}
	result, err := softDeleteAssistantThreads(c.Request.Context(), currentUserOf(c).ID, ids)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, result)
}

// AssistantPlanPatchHandler POST /api/assistant/plan/patch。
func AssistantPlanPatchHandler(c *gin.Context) {
	var req struct {
		ThreadID reqFlexID `json:"threadId"`
		PlanID   string    `json:"planId"`
		TodoID   string    `json:"todoId"`
		Status   string    `json:"status"`
	}
	if err := readBodyStrict(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	planID := strings.TrimSpace(req.PlanID)
	todoID := strings.TrimSpace(req.TodoID)
	if req.ThreadID.Int64() <= 0 || planID == "" || runeLen(planID) > 120 ||
		todoID == "" || runeLen(todoID) > 120 || !planTodoStatuses[req.Status] {
		httpx.ErrorJSON(c, 400, "请求参数错误")
		return
	}
	plan, err := patchAssistantPlanTodo(c.Request.Context(), currentUserOf(c).ID,
		req.ThreadID.Int64(), planID, todoID, req.Status)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, map[string]any{"plan": plan})
}
