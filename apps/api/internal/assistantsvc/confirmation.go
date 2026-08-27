package assistantsvc

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/aicore"
	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/doclibrary"
	"petrichor/api/internal/kb"
	"petrichor/api/internal/sitecontent"
)

const (
	confirmationTicketTTL     = 24 * time.Hour
	requestConfirmationSchema = `{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","minLength":1,"maxLength":160},"title":{"type":"string","minLength":1,"maxLength":200},"description":{"type":"string","maxLength":2000},"variant":{"type":"string","enum":["default","destructive"]},"confirmLabel":{"type":"string","maxLength":40},"cancelLabel":{"type":"string","maxLength":40},"action":{"type":"object","additionalProperties":false,"properties":{"toolName":{"type":"string","minLength":1},"input":{"type":"object"}},"required":["toolName","input"]},"risk":{"const":"dangerous"}},"required":["id","title","action","risk"]}`
)

var dangerousToolNames = map[string]string{
	"delete_article":        "danger.article_delete",
	"revoke_article_share":  "danger.share_revoke",
	"delete_document":       "danger.document_delete",
	"delete_ai_provider":    "danger.ai_provider_delete",
	"update_ai_credential":  "danger.ai_credential_update",
	"revoke_agent_api_key":  "danger.agent_api_key_revoke",
	"set_public_qa_enabled": "danger.public_qa_set_enabled",
}

var destructiveCriticalTools = map[string]bool{
	"delete_article": true, "revoke_article_share": true, "delete_document": true,
	"delete_ai_provider": true, "revoke_agent_api_key": true, "set_public_qa_enabled": true,
}

func registerConfirmationTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.request_confirmation", Name: "request_user_confirmation", Namespace: rt.NamespaceAgent,
		Description: "为危险操作发起确认卡。action.toolName 只允许 delete_article、revoke_article_share、delete_document、delete_ai_provider、update_ai_credential、revoke_agent_api_key、set_public_qa_enabled；确认后由服务端票据执行。",
		InputSchema: schemaJSON(requestConfirmationSchema), RiskLevel: rt.RiskLow,
		AllowedInSubAgent: toolPtr(false), Execute: executeRequestUserConfirmation,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已请求用户确认危险操作", Data: mustJSON(rt.Redact(output)), Progress: boolPtr(true)}
		},
	})

	registerDangerousTool(registry, &rt.AgentToolDefinition{
		ID: "danger.article_delete", Name: "delete_article", Namespace: rt.NamespaceDocument,
		Description: "永久删除文章及其派生数据。只能通过确认票据执行。", InputSchema: schemaJSON(articleIDSchema),
		Execute: executeConfirmedDeleteArticle,
	})
	registerDangerousTool(registry, &rt.AgentToolDefinition{
		ID: "danger.share_revoke", Name: "revoke_article_share", Namespace: rt.NamespaceDocument,
		Description: "撤销文章公开分享。只能通过确认票据执行。", InputSchema: schemaJSON(articleIDSchema),
		Execute: executeConfirmedRevokeArticleShare,
	})
	registerDangerousTool(registry, &rt.AgentToolDefinition{
		ID: "danger.document_delete", Name: "delete_document", Namespace: rt.NamespaceDocument,
		Description: "永久删除文档库文档。只能通过确认票据执行。",
		InputSchema: schemaJSON(`{"type":"object","additionalProperties":false,"properties":{"documentId":{"type":["string","integer"]}},"required":["documentId"]}`),
		Execute:     executeConfirmedDeleteDocument,
	})
	registerDangerousTool(registry, &rt.AgentToolDefinition{
		ID: "danger.ai_provider_delete", Name: "delete_ai_provider", Namespace: rt.NamespaceAdmin,
		Description:      "删除 AI 供应商及其模型。只能通过确认票据执行。",
		InputSchema:      schemaJSON(`{"type":"object","additionalProperties":false,"properties":{"providerId":{"type":["string","integer"]}},"required":["providerId"]}`),
		RequiresOperator: true, Permissions: []string{rt.PermissionAdmin}, Execute: executeConfirmedDeleteAIProvider,
	})
	registerDangerousTool(registry, &rt.AgentToolDefinition{
		ID: "danger.ai_credential_update", Name: "update_ai_credential", Namespace: rt.NamespaceAdmin,
		Description:      "轮换 AI 凭证 API Key。只能通过确认票据执行。",
		InputSchema:      schemaJSON(`{"type":"object","additionalProperties":false,"properties":{"credentialId":{"type":["string","integer"]},"apiKey":{"type":"string","minLength":1}},"required":["credentialId","apiKey"]}`),
		RequiresOperator: true, Permissions: []string{rt.PermissionAdmin}, Execute: executeConfirmedUpdateAICredential,
	})
	registerDangerousTool(registry, &rt.AgentToolDefinition{
		ID: "danger.agent_api_key_revoke", Name: "revoke_agent_api_key", Namespace: rt.NamespaceAdmin,
		Description:      "吊销 Agent API Key。只能通过确认票据执行。",
		InputSchema:      schemaJSON(`{"type":"object","additionalProperties":false,"properties":{"apiKeyId":{"type":["string","integer"]}},"required":["apiKeyId"]}`),
		RequiresOperator: true, Permissions: []string{rt.PermissionAdmin}, Execute: executeConfirmedRevokeAgentAPIKey,
	})
	registerDangerousTool(registry, &rt.AgentToolDefinition{
		ID: "danger.public_qa_set_enabled", Name: "set_public_qa_enabled", Namespace: rt.NamespaceAdmin,
		Description:      "设置站点公开问答开关。只能由超级管理员通过确认票据执行。",
		InputSchema:      schemaJSON(`{"type":"object","additionalProperties":false,"properties":{"enabled":{"type":"boolean"}},"required":["enabled"]}`),
		RequiresOperator: true, Permissions: []string{rt.PermissionAdmin}, Execute: executeConfirmedSetPublicQA,
	})
}

func registerDangerousTool(registry interface {
	Register(tool *rt.AgentToolDefinition)
}, tool *rt.AgentToolDefinition) {
	tool.RiskLevel = rt.RiskHigh
	tool.SideEffect = true
	tool.RequiresConfirmation = true
	tool.AllowedInSubAgent = toolPtr(false)
	registry.Register(tool)
}

func executeRequestUserConfirmation(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	confirmationID := strings.TrimSpace(stringValue(params["id"]))
	if confirmationID == "" {
		return nil, rt.ValidationError("确认 ID 不能为空")
	}
	action, ok := params["action"].(map[string]any)
	if !ok {
		return nil, rt.ValidationError("确认 action 无效")
	}
	toolName := strings.TrimSpace(stringValue(action["toolName"]))
	actionInput, ok := action["input"].(map[string]any)
	if !ok {
		return nil, rt.ValidationError("确认 action.input 无效")
	}
	tool, err := dangerousToolDefinition(toolName)
	if err != nil {
		return nil, err
	}
	if tool.RequiresOperator && !rt.IsAssistantOperator(ctx.SystemRole) {
		return nil, rt.PermissionDenied("危险管理操作仅限操作员")
	}
	if err := rt.ValidateToolInput(tool.InputSchema, actionInput); err != nil {
		return nil, rt.ValidationError(err.Error())
	}
	threadID, err := confirmationThreadID(ctx)
	if err != nil {
		return nil, err
	}
	if !destructiveCriticalTools[toolName] {
		allowed, allowErr := isToolInThreadDangerAllowlist(toolContext(ctx), threadID, ctx.UserID, toolName)
		if allowErr != nil {
			return nil, allowErr
		}
		if allowed {
			outcome, executeErr := executeConfirmedDangerousAction(ctx, toolName, actionInput)
			if executeErr != nil {
				return nil, executeErr
			}
			result := cloneAnyMap(params)
			result["autoApproved"] = true
			result["confirmed"] = true
			result["confirmationId"] = confirmationID
			result["executionOutcome"] = outcome
			return result, nil
		}
	}
	if err := issueAssistantConfirmation(ctx, threadID, confirmationID, toolName, actionInput); err != nil {
		return nil, err
	}
	return params, nil
}

func dangerousToolDefinition(toolName string) (*rt.AgentToolDefinition, error) {
	toolID, allowed := dangerousToolNames[toolName]
	if !allowed {
		return nil, rt.ValidationError("不允许确认执行未知危险工具：" + toolName)
	}
	tool := rt.DefaultToolRegistry().Get(toolID)
	if tool == nil || tool.Name != toolName || tool.RiskLevel != rt.RiskHigh || !tool.RequiresConfirmation {
		return nil, rt.ValidationError("危险工具未正确注册：" + toolName)
	}
	return tool, nil
}

func confirmationThreadID(ctx *rt.ToolExecutionContext) (int64, error) {
	if ctx.ThreadID > 0 {
		return ctx.ThreadID, nil
	}
	id, err := requiredToolID(ctx.ConversationID, "threadId")
	if err != nil {
		return 0, rt.ValidationError("当前对话缺少可用 threadId")
	}
	return id, nil
}

func confirmationStorageKey(threadID int64, confirmationID string) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d:%s", threadID, confirmationID)))
	return "v1:" + hex.EncodeToString(sum[:])
}

func issueAssistantConfirmation(ctx *rt.ToolExecutionContext, threadID int64, confirmationID, toolName string, actionInput map[string]any) error {
	inputJSON, err := json.Marshal(actionInput)
	if err != nil {
		return rt.ValidationError("确认参数无法序列化")
	}
	encodedInput, err := aicore.EncodeApiKey(string(inputJSON))
	if err != nil {
		return err
	}
	storedInput := "enc:v1:" + encodedInput
	tag, err := dbPool().Exec(toolContext(ctx), `
		INSERT INTO petrichor_assistant_confirmation
		(confirmation_key,thread_id,user_id,tool_name,input_json,status,consumed_at,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,'pending',NULL,now(),now())
		ON CONFLICT (confirmation_key) DO UPDATE SET
		 tool_name=excluded.tool_name,input_json=excluded.input_json,status='pending',consumed_at=NULL,updated_at=now()
		WHERE petrichor_assistant_confirmation.thread_id=excluded.thread_id
		  AND petrichor_assistant_confirmation.user_id=excluded.user_id`,
		confirmationStorageKey(threadID, confirmationID), threadID, ctx.UserID, toolName, storedInput)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return rt.PermissionDenied("确认 ID 与其他会话冲突")
	}
	return nil
}

type storedConfirmationAction struct {
	ToolName string
	Input    map[string]any
}

type pendingConfirmationExecution struct {
	ConfirmationID string
	AllowForThread bool
}

type pendingConfirmationDecision struct {
	ConfirmationID string
	Confirmed      bool
	AllowForThread bool
}

// findPendingConfirmationExecution 只从客户端消息提取服务端票据 ID；action 永远不取客户端值。
func findPendingConfirmationExecution(messages []json.RawMessage) *pendingConfirmationExecution {
	decision := findPendingConfirmationDecision(messages)
	if decision == nil || !decision.Confirmed {
		return nil
	}
	return &pendingConfirmationExecution{ConfirmationID: decision.ConfirmationID, AllowForThread: decision.AllowForThread}
}

func findPendingConfirmationDecision(messages []json.RawMessage) *pendingConfirmationDecision {
	for messageIndex := len(messages) - 1; messageIndex >= 0; messageIndex-- {
		var message map[string]any
		if json.Unmarshal(messages[messageIndex], &message) != nil || message["role"] != "assistant" {
			continue
		}
		parts, _ := message["parts"].([]any)
		if len(parts) == 0 {
			parts, _ = message["content"].([]any)
		}
		for partIndex := len(parts) - 1; partIndex >= 0; partIndex-- {
			part, _ := parts[partIndex].(map[string]any)
			if part == nil || historicalToolName(part) != "request_user_confirmation" {
				continue
			}
			result, _ := confirmationPartValue(part, "output", "result").(map[string]any)
			confirmed, hasDecision := result["confirmed"].(bool)
			if result == nil || !hasDecision {
				continue
			}
			if _, alreadyExecuted := result["executionOutcome"]; alreadyExecuted {
				continue
			}
			confirmationID := strings.TrimSpace(stringValue(result["confirmationId"]))
			if confirmationID == "" {
				continue
			}
			args, _ := confirmationPartValue(part, "input", "args").(map[string]any)
			if args == nil || strings.TrimSpace(stringValue(args["id"])) != confirmationID {
				continue
			}
			allowForThread, _ := result["allowForThread"].(bool)
			return &pendingConfirmationDecision{ConfirmationID: confirmationID, Confirmed: confirmed, AllowForThread: allowForThread}
		}
	}
	return nil
}

func cancelAssistantConfirmation(ctx *rt.ToolExecutionContext, threadID int64, confirmationID string) error {
	_, err := dbPool().Exec(toolContext(ctx), `
		UPDATE petrichor_assistant_confirmation SET status='cancelled',consumed_at=now(),updated_at=now()
		WHERE confirmation_key=$1 AND thread_id=$2 AND user_id=$3 AND status='pending'`,
		confirmationStorageKey(threadID, confirmationID), threadID, ctx.UserID)
	return err
}

func confirmationPartValue(part map[string]any, keys ...string) any {
	if value := firstHistoricalPartValue(part, keys...); value != nil {
		return value
	}
	if invocation, ok := part["toolInvocation"].(map[string]any); ok {
		return firstHistoricalPartValue(invocation, keys...)
	}
	return nil
}

func patchConfirmationExecutionOutcome(messages []json.RawMessage, confirmationID string, outcome any) []json.RawMessage {
	patched := make([]json.RawMessage, 0, len(messages))
	for _, raw := range messages {
		var message map[string]any
		if json.Unmarshal(raw, &message) != nil || message["role"] != "assistant" {
			patched = append(patched, raw)
			continue
		}
		changed := patchConfirmationParts(message["parts"], confirmationID, outcome)
		if !changed {
			changed = patchConfirmationParts(message["content"], confirmationID, outcome)
		}
		if !changed {
			patched = append(patched, raw)
			continue
		}
		next, err := json.Marshal(message)
		if err != nil {
			patched = append(patched, raw)
		} else {
			patched = append(patched, next)
		}
	}
	return patched
}

func patchConfirmationParts(rawParts any, confirmationID string, outcome any) bool {
	parts, ok := rawParts.([]any)
	if !ok {
		return false
	}
	changed := false
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		if part == nil || historicalToolName(part) != "request_user_confirmation" {
			continue
		}
		result, _ := confirmationPartValue(part, "output", "result").(map[string]any)
		if result == nil || strings.TrimSpace(stringValue(result["confirmationId"])) != confirmationID {
			continue
		}
		nextResult := cloneAnyMap(result)
		nextResult["executionOutcome"] = outcome
		switch {
		case part["output"] != nil:
			part["output"] = nextResult
		case part["result"] != nil:
			part["result"] = nextResult
		case part["toolInvocation"] != nil:
			invocation, _ := part["toolInvocation"].(map[string]any)
			if invocation != nil {
				if invocation["output"] != nil {
					invocation["output"] = nextResult
				} else {
					invocation["result"] = nextResult
				}
			}
		default:
			part["result"] = nextResult
		}
		changed = true
	}
	return changed
}

// persistConfirmationExecutionOutcome 让刷新后的历史消息也保留确认决定与执行结果。
func persistConfirmationExecutionOutcome(ctx *rt.ToolExecutionContext, threadID int64, confirmationID string, decision, outcome any) {
	rows, err := dbPool().Query(toolContext(ctx), `
		SELECT id,content_json FROM petrichor_assistant_message
		WHERE thread_id=$1 AND role='assistant' ORDER BY created_at DESC,id DESC LIMIT 20`, threadID)
	if err != nil {
		return
	}
	var targetMessageID int64
	var targetContent map[string]any
	for rows.Next() {
		var messageID int64
		var contentJSON string
		if rows.Scan(&messageID, &contentJSON) != nil {
			continue
		}
		var content map[string]any
		if json.Unmarshal([]byte(contentJSON), &content) != nil {
			continue
		}
		parts, _ := content["parts"].([]any)
		if !persistedConfirmationPartPatch(parts, confirmationID, decision, outcome) {
			continue
		}
		targetMessageID = messageID
		targetContent = content
		break
	}
	rows.Close()
	if targetMessageID == 0 || targetContent == nil {
		return
	}
	next, marshalErr := json.Marshal(targetContent)
	if marshalErr == nil {
		_, _ = dbPool().Exec(toolContext(ctx), `UPDATE petrichor_assistant_message SET content_json=$1 WHERE id=$2 AND thread_id=$3`, string(next), targetMessageID, threadID)
	}
}

func persistedConfirmationPartPatch(parts []any, confirmationID string, decision, outcome any) bool {
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		if part == nil || historicalToolName(part) != "request_user_confirmation" {
			continue
		}
		input, _ := confirmationPartValue(part, "input", "args").(map[string]any)
		if input == nil || strings.TrimSpace(stringValue(input["id"])) != confirmationID {
			continue
		}
		result := cloneAnyMap(input)
		if decided, ok := decision.(map[string]any); ok {
			for key, value := range decided {
				result[key] = value
			}
		} else {
			result["confirmed"] = true
			result["confirmationId"] = confirmationID
		}
		result["executionOutcome"] = outcome
		part["output"] = result
		part["state"] = "output-available"
		return true
	}
	return false
}

func consumeAssistantConfirmation(ctx *rt.ToolExecutionContext, threadID int64, confirmationID string) (*storedConfirmationAction, error) {
	var toolName, inputJSON string
	err := dbPool().QueryRow(toolContext(ctx), `
		UPDATE petrichor_assistant_confirmation SET status='consumed',consumed_at=now(),updated_at=now()
		WHERE confirmation_key=$1 AND thread_id=$2 AND user_id=$3 AND status='pending'
		  AND updated_at > now() - interval '24 hours'
		RETURNING tool_name,input_json`, confirmationStorageKey(threadID, confirmationID), threadID, ctx.UserID).
		Scan(&toolName, &inputJSON)
	if err == pgx.ErrNoRows {
		return nil, rt.ValidationError("确认已失效或不可用（可能已执行、伪造、过期或归属不符）")
	}
	if err != nil {
		return nil, err
	}
	plainInput := inputJSON
	if strings.HasPrefix(inputJSON, "enc:v1:") {
		plainInput = aicore.DecodeApiKey(strings.TrimPrefix(inputJSON, "enc:v1:"))
		if plainInput == "" {
			return nil, rt.ValidationError("确认票据参数无法解密")
		}
	}
	var input map[string]any
	if json.Unmarshal([]byte(plainInput), &input) != nil || input == nil {
		return nil, rt.ValidationError("确认票据参数损坏")
	}
	if _, err := dangerousToolDefinition(toolName); err != nil {
		return nil, err
	}
	return &storedConfirmationAction{ToolName: toolName, Input: input}, nil
}

func executeConfirmedDangerousAction(ctx *rt.ToolExecutionContext, toolName string, input map[string]any) (any, error) {
	tool, err := dangerousToolDefinition(toolName)
	if err != nil {
		return nil, err
	}
	if err := rt.ValidateToolInput(tool.InputSchema, input); err != nil {
		return nil, rt.ValidationError(err.Error())
	}
	confirmedCtx := *ctx
	confirmedCtx.ConfirmedAction = true
	return tool.Execute(&confirmedCtx, input)
}

func requireConfirmedAction(ctx *rt.ToolExecutionContext) error {
	if ctx == nil || !ctx.ConfirmedAction {
		return rt.PermissionDenied("危险操作必须先通过 request_user_confirmation，不能直接调用")
	}
	return nil
}

func executeConfirmedDeleteArticle(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if err := requireConfirmedAction(ctx); err != nil {
		return nil, err
	}
	params, _ := input.(map[string]any)
	articleID, err := requiredToolID(params["articleId"], "articleId")
	if err != nil {
		return nil, err
	}
	tx, err := dbPool().Begin(toolContext(ctx))
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(toolContext(ctx))
	article, err := kb.QueryOwnedArticleForAgent(tx, ctx.UserID, articleID)
	if err != nil {
		return nil, err
	}
	if article == nil {
		return nil, rt.ValidationError("文章不存在或不属于当前用户")
	}
	if _, err := kb.DeleteArticleWikiPagesForAgent(tx, ctx.UserID, []kb.ArticleRow{*article}, true); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(toolContext(ctx), `DELETE FROM petrichor_kb_article WHERE id=$1 AND user_id=$2`, article.ID, ctx.UserID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(toolContext(ctx), `DELETE FROM petrichor_kb_node WHERE id=$1 AND user_id=$2`, article.NodeID, ctx.UserID); err != nil {
		return nil, err
	}
	if err := tx.Commit(toolContext(ctx)); err != nil {
		return nil, err
	}
	kb.InvalidatePublicArticleCaches("")
	return map[string]any{"articleId": idStr(article.ID), "nodeId": idStr(article.NodeID), "deleted": true}, nil
}

func executeConfirmedRevokeArticleShare(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if err := requireConfirmedAction(ctx); err != nil {
		return nil, err
	}
	params, _ := input.(map[string]any)
	articleID, err := requiredToolID(params["articleId"], "articleId")
	if err != nil {
		return nil, err
	}
	if _, err := loadAssistantArticleForUpdate(dbPool(), ctx, articleID, false); err != nil {
		return nil, err
	}
	var shareID int64
	var shareCode string
	var enabled bool
	err = dbPool().QueryRow(toolContext(ctx), `SELECT id,share_code,enabled FROM petrichor_kb_article_share WHERE article_id=$1 LIMIT 1`, articleID).Scan(&shareID, &shareCode, &enabled)
	if err == pgx.ErrNoRows || !enabled {
		return map[string]any{"articleId": idStr(articleID), "enabled": false, "revoked": false}, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := dbPool().Exec(toolContext(ctx), `UPDATE petrichor_kb_article_share SET enabled=false,revoked_at=now(),updated_at=now() WHERE id=$1`, shareID); err != nil {
		return nil, err
	}
	kb.InvalidatePublicArticleCaches(shareCode)
	return map[string]any{"articleId": idStr(articleID), "enabled": false, "revoked": true}, nil
}

func executeConfirmedDeleteDocument(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if err := requireConfirmedAction(ctx); err != nil {
		return nil, err
	}
	params, _ := input.(map[string]any)
	documentID, err := requiredToolID(params["documentId"], "documentId")
	if err != nil {
		return nil, err
	}
	return doclibrary.DeleteDocument(toolContext(ctx), ctx.UserID, documentID)
}

func requireConfirmedOperator(ctx *rt.ToolExecutionContext) error {
	if err := requireConfirmedAction(ctx); err != nil {
		return err
	}
	if !rt.IsAssistantOperator(ctx.SystemRole) {
		return rt.PermissionDenied("危险管理操作仅限操作员")
	}
	return nil
}

func executeConfirmedDeleteAIProvider(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if err := requireConfirmedOperator(ctx); err != nil {
		return nil, err
	}
	params, _ := input.(map[string]any)
	providerID, err := requiredToolID(params["providerId"], "providerId")
	if err != nil {
		return nil, err
	}
	var bound int64
	err = dbPool().QueryRow(toolContext(ctx), `
		SELECT count(*) FROM petrichor_ai_binding b JOIN petrichor_ai_model m ON m.id=b.model_ref_id
		WHERE b.user_id=$1 AND m.provider_id=$2`, ctx.UserID, providerID).Scan(&bound)
	if err != nil {
		return nil, err
	}
	if bound > 0 {
		return nil, rt.ValidationError(fmt.Sprintf("该供应商下有 %d 个模型正被用途绑定使用，请先改绑其它模型", bound))
	}
	tag, err := dbPool().Exec(toolContext(ctx), `DELETE FROM petrichor_ai_provider WHERE id=$1 AND user_id=$2`, providerID, ctx.UserID)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, rt.ValidationError("供应商不存在或不属于当前用户")
	}
	return map[string]any{"providerId": idStr(providerID), "deleted": true}, nil
}

func executeConfirmedUpdateAICredential(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if err := requireConfirmedOperator(ctx); err != nil {
		return nil, err
	}
	params, _ := input.(map[string]any)
	credentialID, err := requiredToolID(params["credentialId"], "credentialId")
	if err != nil {
		return nil, err
	}
	apiKey := strings.TrimSpace(stringValue(params["apiKey"]))
	if apiKey == "" {
		return nil, rt.ValidationError("apiKey 不能为空")
	}
	encoded, err := aicore.EncodeApiKey(apiKey)
	if err != nil {
		return nil, err
	}
	var name string
	err = dbPool().QueryRow(toolContext(ctx), `
		UPDATE petrichor_ai_credential SET api_key_enc=$1,updated_at=now()
		WHERE id=$2 AND user_id=$3 RETURNING name`, encoded, credentialID, ctx.UserID).Scan(&name)
	if err == pgx.ErrNoRows {
		return nil, rt.ValidationError("凭证不存在或不属于当前用户")
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": idStr(credentialID), "name": name, "rotated": true}, nil
}

func executeConfirmedRevokeAgentAPIKey(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if err := requireConfirmedOperator(ctx); err != nil {
		return nil, err
	}
	params, _ := input.(map[string]any)
	apiKeyID, err := requiredToolID(params["apiKeyId"], "apiKeyId")
	if err != nil {
		return nil, err
	}
	var name, prefix string
	var revokedAt time.Time
	err = dbPool().QueryRow(toolContext(ctx), `
		UPDATE petrichor_agent_api_key SET revoked_at=now(),updated_at=now()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING name,key_prefix,revoked_at`, apiKeyID, ctx.UserID).
		Scan(&name, &prefix, &revokedAt)
	if err == pgx.ErrNoRows {
		return nil, rt.ValidationError("API Key 不存在、已吊销或不属于当前用户")
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"item": map[string]any{"id": idStr(apiKeyID), "name": name, "keyPrefix": prefix, "revokedAt": revokedAt.Format(time.RFC3339Nano)}}, nil
}

func executeConfirmedSetPublicQA(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if err := requireConfirmedOperator(ctx); err != nil {
		return nil, err
	}
	var role string
	if err := dbPool().QueryRow(toolContext(ctx), `SELECT system_role FROM petrichor_user WHERE id=$1`, ctx.UserID).Scan(&role); err != nil || role != "SUPER_ADMIN" {
		return nil, rt.PermissionDenied("仅超级管理员可设置公开问答开关")
	}
	params, _ := input.(map[string]any)
	enabled, ok := params["enabled"].(bool)
	if !ok {
		return nil, rt.ValidationError("enabled 必须是布尔值")
	}
	if _, err := dbPool().Exec(toolContext(ctx), `
		INSERT INTO petrichor_site_appearance (id,public_qa_enabled,created_at,updated_at)
		VALUES (1,$1,now(),now())
		ON CONFLICT (id) DO UPDATE SET public_qa_enabled=excluded.public_qa_enabled,updated_at=excluded.updated_at`, enabled); err != nil {
		return nil, err
	}
	sitecontent.InvalidateSiteAppearanceCache()
	return map[string]any{"publicQaEnabled": enabled}, nil
}

type dangerAllowlistState struct {
	ToolNames []string  `json:"toolNames"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func isToolInThreadDangerAllowlist(ctx context.Context, threadID, userID int64, toolName string) (bool, error) {
	var raw *string
	err := dbPool().QueryRow(ctx, `
		SELECT danger_allowlist_json FROM petrichor_assistant_thread
		WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, threadID, userID).Scan(&raw)
	if err == pgx.ErrNoRows {
		return false, rt.PermissionDenied("对话不存在或不属于当前用户")
	}
	if err != nil || raw == nil {
		return false, err
	}
	state := parseDangerAllowlist(*raw)
	if state == nil || time.Since(state.UpdatedAt) > confirmationTicketTTL {
		if state != nil {
			_, _ = dbPool().Exec(ctx, `UPDATE petrichor_assistant_thread SET danger_allowlist_json=NULL,updated_at=now() WHERE id=$1 AND user_id=$2`, threadID, userID)
		}
		return false, nil
	}
	for _, name := range state.ToolNames {
		if name == toolName {
			return true, nil
		}
	}
	return false, nil
}

func parseDangerAllowlist(raw string) *dangerAllowlistState {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var wire struct {
		ToolNames []string `json:"toolNames"`
		UpdatedAt string   `json:"updatedAt"`
	}
	if json.Unmarshal([]byte(raw), &wire) != nil || strings.TrimSpace(wire.UpdatedAt) == "" {
		return nil
	}
	updatedAt, err := time.Parse(time.RFC3339, wire.UpdatedAt)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	names := []string{}
	for _, name := range wire.ToolNames {
		if _, allowed := dangerousToolNames[name]; allowed && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	return &dangerAllowlistState{ToolNames: names, UpdatedAt: updatedAt}
}

func addToolToThreadDangerAllowlist(ctx *rt.ToolExecutionContext, threadID int64, toolName string) error {
	if destructiveCriticalTools[toolName] {
		return nil
	}
	allowed, err := isToolInThreadDangerAllowlist(toolContext(ctx), threadID, ctx.UserID, toolName)
	if err != nil {
		return err
	}
	if allowed {
		return nil
	}
	var raw *string
	if err := dbPool().QueryRow(toolContext(ctx), `SELECT danger_allowlist_json FROM petrichor_assistant_thread WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, threadID, ctx.UserID).Scan(&raw); err != nil {
		return err
	}
	names := []string{}
	if raw != nil {
		if state := parseDangerAllowlist(*raw); state != nil && time.Since(state.UpdatedAt) <= confirmationTicketTTL {
			names = append(names, state.ToolNames...)
		}
	}
	seen := map[string]bool{}
	unique := []string{}
	for _, name := range append(names, toolName) {
		if _, exists := dangerousToolNames[name]; exists && !seen[name] && !destructiveCriticalTools[name] {
			seen[name] = true
			unique = append(unique, name)
		}
	}
	stateJSON, _ := json.Marshal(map[string]any{"toolNames": unique, "updatedAt": time.Now().UTC().Format(time.RFC3339)})
	tag, err := dbPool().Exec(toolContext(ctx), `UPDATE petrichor_assistant_thread SET danger_allowlist_json=$1,updated_at=now() WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL`, string(stateJSON), threadID, ctx.UserID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return rt.PermissionDenied("对话不存在或不属于当前用户")
	}
	return nil
}

func cloneAnyMap(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
