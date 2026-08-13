package assistant

import (
	"encoding/json"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantplan"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantthread"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

// PatchPlanTodo 更新计划中某个 todo 的状态。
func (r *Runtime) PatchPlanTodo(c *gin.Context) {
	var req struct {
		ThreadID assistantID `json:"threadId"`
		PlanID   string      `json:"planId" binding:"required"`
		TodoID   string      `json:"todoId" binding:"required"`
		Status   string      `json:"status" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	status := strings.TrimSpace(req.Status)
	switch status {
	case "pending", "in_progress", "completed", "cancelled":
	default:
		response.Fail(c, response.BadRequest("status 无效"))
		return
	}
	threadID, err := parsePositiveID(string(req.ThreadID), "threadId")
	if err != nil {
		response.Fail(c, response.BadRequest(err.Error()))
		return
	}
	planID := strings.TrimSpace(req.PlanID)
	todoID := strings.TrimSpace(req.TodoID)
	if planID == "" || len([]rune(planID)) > 120 || todoID == "" || len([]rune(todoID)) > 120 {
		response.Fail(c, response.BadRequest("planId 和 todoId 不能为空且不能超过 120 个字符"))
		return
	}
	u := auth.MustUser(c)
	exists, err := r.client.AssistantThread.Query().
		Where(assistantthread.IDEQ(threadID), assistantthread.UserIDEQ(u.ID), assistantthread.DeletedAtIsNil()).
		Exist(c.Request.Context())
	if err != nil || !exists {
		response.Fail(c, response.NotFound("对话不存在"))
		return
	}

	planQuery := r.client.AssistantPlan.Query().
		Where(
			assistantplan.ThreadIDEQ(threadID), assistantplan.UserIDEQ(u.ID),
			assistantplan.PlanKeyEQ(planID), assistantplan.StatusEQ("active"),
		)
	plan, err := planQuery.First(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("计划不存在"))
			return
		}
		response.Fail(c, err)
		return
	}

	var todos []map[string]any
	raw := "{}"
	if plan.TodosJSON != "" {
		raw = plan.TodosJSON
	}
	if err := json.Unmarshal([]byte(raw), &todos); err != nil {
		// 兼容 {todos:[...]} 包裹
		var wrap struct {
			Todos []map[string]any `json:"todos"`
		}
		if err2 := json.Unmarshal([]byte(raw), &wrap); err2 != nil {
			response.Fail(c, response.BadRequest("计划数据损坏"))
			return
		}
		todos = wrap.Todos
	}
	found := false
	for i := range todos {
		id, _ := todos[i]["id"].(string)
		if id == todoID {
			todos[i]["status"] = status
			found = true
			break
		}
	}
	if !found {
		response.Fail(c, response.NotFound("步骤不存在"))
		return
	}
	encoded, _ := json.Marshal(todos)
	updated, err := plan.Update().SetTodosJSON(string(encoded)).Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	planResp := gin.H{
		"id":    updated.PlanKey,
		"title": updated.Title,
		"todos": todos,
	}
	if updated.Description != nil {
		planResp["description"] = *updated.Description
	}
	response.OK(c, gin.H{"plan": planResp})
}
