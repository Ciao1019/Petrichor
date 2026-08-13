package assistant

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantmessage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantplan"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantthread"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

func parseAssistantFocus(raw *string) *AssistantFocus {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var focus AssistantFocus
	if err := json.Unmarshal([]byte(*raw), &focus); err != nil {
		return nil
	}
	return &focus
}

func toThreadSummary(row *ent.AssistantThread) gin.H {
	return gin.H{
		"id":        fmt.Sprintf("%d", row.ID),
		"title":     row.Title,
		"focus":     parseAssistantFocus(row.FocusJSON),
		"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano),
		"updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func (r *Runtime) ListThreads(c *gin.Context) {
	var req struct {
		Cursor *int    `json:"cursor"`
		Limit  *int    `json:"limit"`
		Q      *string `json:"q"`
	}
	if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, io.EOF) {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	limit := 30
	if req.Limit != nil {
		if *req.Limit < 1 || *req.Limit > 100 {
			response.Fail(c, response.BadRequest("limit 必须在 1 到 100 之间"))
			return
		}
		limit = *req.Limit
	}
	offset := 0
	if req.Cursor != nil {
		if *req.Cursor < 0 {
			response.Fail(c, response.BadRequest("cursor 不能小于 0"))
			return
		}
		offset = *req.Cursor
	}
	u := auth.MustUser(c)
	q := r.client.AssistantThread.Query().
		Where(assistantthread.UserIDEQ(u.ID), assistantthread.DeletedAtIsNil()).
		Order(ent.Desc(assistantthread.FieldUpdatedAt), ent.Desc(assistantthread.FieldID))
	if req.Q != nil {
		keyword := strings.TrimSpace(*req.Q)
		if len([]rune(keyword)) > 120 {
			response.Fail(c, response.BadRequest("q 不能超过 120 个字符"))
			return
		}
		if keyword != "" {
			q = q.Where(assistantthread.TitleContainsFold(keyword))
		}
	}
	rows, err := q.Offset(offset).Limit(limit + 1).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	var nextCursor *int
	if len(rows) > limit {
		next := offset + limit
		nextCursor = &next
		rows = rows[:limit]
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		items = append(items, toThreadSummary(row))
	}
	response.OK(c, gin.H{"items": items, "nextCursor": nextCursor})
}

func (r *Runtime) CreateThread(c *gin.Context) {
	var req struct {
		Title *string         `json:"title"`
		Focus *AssistantFocus `json:"focus"`
	}
	if err := c.ShouldBindJSON(&req); err != nil && !errors.Is(err, io.EOF) {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	title := "新对话"
	if req.Title != nil {
		value := strings.TrimSpace(*req.Title)
		if len([]rune(value)) > 120 {
			response.Fail(c, response.BadRequest("title 不能超过 120 个字符"))
			return
		}
		title = summarizeThreadTitle(value)
	}
	u := auth.MustUser(c)
	if err := r.assertAssistantFocusOwnership(c.Request.Context(), u.ID, req.Focus); err != nil {
		response.Fail(c, err)
		return
	}
	builder := r.client.AssistantThread.Create().SetUserID(u.ID).SetTitle(title)
	if req.Focus != nil {
		raw, _ := json.Marshal(req.Focus)
		s := string(raw)
		builder.SetFocusJSON(s)
	}
	row, err := builder.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"thread": toThreadSummary(row)})
}

func (r *Runtime) DetailThread(c *gin.Context) {
	var req struct {
		ThreadID assistantID `json:"threadId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(string(req.ThreadID), "threadId")
	if err != nil {
		response.Fail(c, response.BadRequest(err.Error()))
		return
	}
	u := auth.MustUser(c)
	row, err := r.client.AssistantThread.Query().
		Where(assistantthread.IDEQ(id), assistantthread.UserIDEQ(u.ID), assistantthread.DeletedAtIsNil()).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("对话不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	msgs, err := r.client.AssistantMessage.Query().
		Where(assistantmessage.ThreadIDEQ(id)).
		Order(ent.Desc(assistantmessage.FieldCreatedAt), ent.Desc(assistantmessage.FieldID)).
		Limit(200).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	for left, right := 0, len(msgs)-1; left < right; left, right = left+1, right-1 {
		msgs[left], msgs[right] = msgs[right], msgs[left]
	}
	messageItems := make([]gin.H, 0, len(msgs))
	for _, m := range msgs {
		var content any
		if m.ContentJSON != nil {
			_ = json.Unmarshal([]byte(*m.ContentJSON), &content)
		}
		messageItems = append(messageItems, gin.H{
			"id":        fmt.Sprintf("%d", m.ID),
			"role":      m.Role,
			"content":   content,
			"createdAt": m.CreatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	plans, err := r.client.AssistantPlan.Query().
		Where(assistantplan.ThreadIDEQ(id), assistantplan.UserIDEQ(u.ID), assistantplan.StatusEQ("active")).
		Order(ent.Desc(assistantplan.FieldUpdatedAt), ent.Desc(assistantplan.FieldID)).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	planItems := make([]gin.H, 0, len(plans))
	for _, p := range plans {
		var todos []map[string]any
		if err := json.Unmarshal([]byte(p.TodosJSON), &todos); err != nil || len(todos) == 0 {
			continue
		}
		item := gin.H{
			"id":    p.PlanKey,
			"title": p.Title,
			"todos": todos,
		}
		if p.Description != nil {
			item["description"] = *p.Description
		}
		planItems = append(planItems, item)
	}
	response.OK(c, gin.H{
		"thread":    toThreadSummary(row),
		"messages":  messageItems,
		"plans":     planItems,
		"truncated": len(msgs) >= 200,
	})
}

func (r *Runtime) DeleteThread(c *gin.Context) {
	var req struct {
		ThreadID assistantID `json:"threadId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(string(req.ThreadID), "threadId")
	if err != nil {
		response.Fail(c, response.BadRequest(err.Error()))
		return
	}
	u := auth.MustUser(c)
	now := time.Now().UTC()
	n, err := r.client.AssistantThread.Update().
		Where(assistantthread.IDEQ(id), assistantthread.UserIDEQ(u.ID), assistantthread.DeletedAtIsNil()).
		SetDeletedAt(now).
		SetUpdatedAt(now).
		Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if n == 0 {
		response.Fail(c, response.NotFound("对话不存在"))
		return
	}
	response.OK(c, gin.H{"ok": true})
}

func (r *Runtime) DeleteManyThreads(c *gin.Context) {
	var req struct {
		ThreadIDs []assistantID `json:"threadIds"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	if len(req.ThreadIDs) < 1 || len(req.ThreadIDs) > 200 {
		response.Fail(c, response.BadRequest("threadIds 数量必须在 1 到 200 之间"))
		return
	}
	u := auth.MustUser(c)
	ids := make([]int64, 0, len(req.ThreadIDs))
	for _, raw := range req.ThreadIDs {
		id, err := parsePositiveID(string(raw), "threadId")
		if err != nil {
			response.Fail(c, response.BadRequest(err.Error()))
			return
		}
		ids = append(ids, id)
	}
	now := time.Now().UTC()
	n, err := r.client.AssistantThread.Update().
		Where(assistantthread.UserIDEQ(u.ID), assistantthread.IDIn(ids...), assistantthread.DeletedAtIsNil()).
		SetDeletedAt(now).
		SetUpdatedAt(now).
		Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"deleted": n})
}
