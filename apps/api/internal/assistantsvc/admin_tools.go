package assistantsvc

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/auth"
	httpx "petrichor/api/internal/httpx"
)

const (
	adminListModelsSchema = `{"type":"object","properties":{"purpose":{"type":"string","enum":["CHAT","VISION","DOC_QA","EMBEDDING"]}}}`
	adminBindModelSchema  = `{"type":"object","properties":{"purpose":{"type":"string","enum":["CHAT","VISION","DOC_QA","EMBEDDING"]},"modelRefId":{"type":["string","integer"]}},"required":["purpose","modelRefId"]}`
)

func registerAdminTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "admin.list_models", Name: "list_ai_models", Namespace: rt.NamespaceAdmin,
		Description: "列出当前操作员已接入的 AI 模型及各用途绑定，结果已脱敏且不含 API Key。",
		InputSchema: schemaJSON(adminListModelsSchema), RiskLevel: rt.RiskMedium,
		RequiresOperator: true, AllowedInSubAgent: toolPtr(false), Permissions: []string{rt.PermissionAdmin},
		Execute: executeAdminListModels, Normalize: normalizeAdminList("模型配置", "models"),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "admin.list_api_keys", Name: "list_agent_api_keys", Namespace: rt.NamespaceAdmin,
		Description: "列出当前操作员尚未吊销且未过期的 Agent API Key，仅返回前缀与元信息。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`), RiskLevel: rt.RiskMedium,
		RequiresOperator: true, AllowedInSubAgent: toolPtr(false), Permissions: []string{rt.PermissionAdmin},
		Execute: executeAdminListAPIKeys, Normalize: normalizeAdminList("API Key", "items"),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "admin.get_public_qa", Name: "get_public_qa_setting", Namespace: rt.NamespaceAdmin,
		Description: "读取站点公开问答开关 publicQaEnabled。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`), RiskLevel: rt.RiskMedium,
		RequiresOperator: true, AllowedInSubAgent: toolPtr(false), Permissions: []string{rt.PermissionAdmin},
		Execute: executeAdminGetPublicQA,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已读取公开问答设置", Data: mustJSON(output), Progress: boolPtr(true)}
		},
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "admin.bind_model", Name: "bind_ai_model", Namespace: rt.NamespaceAdmin,
		Description: "把指定模型绑定到 CHAT / VISION / DOC_QA / EMBEDDING 用途；会改变后续模型调用。",
		InputSchema: schemaJSON(adminBindModelSchema), RiskLevel: rt.RiskMedium, SideEffect: true,
		RequiresOperator: true, AllowedInSubAgent: toolPtr(false), Permissions: []string{rt.PermissionAdmin},
		Execute: executeAdminBindModel,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "模型用途绑定已更新", Data: mustJSON(output), Progress: boolPtr(true)}
		},
	})
}

func normalizeAdminList(label, key string) rt.ToolNormalizer {
	return func(output any, _ any) rt.ToolNormalizerResult {
		raw, _ := json.Marshal(output)
		var record map[string]json.RawMessage
		_ = json.Unmarshal(raw, &record)
		var items []any
		_ = json.Unmarshal(record[key], &items)
		summary := "没有找到" + label
		if len(items) > 0 {
			summary = fmt.Sprintf("找到 %d 条%s", len(items), label)
		}
		return rt.ToolNormalizerResult{Summary: summary, Data: mustJSON(map[string]any{"items": items}), Progress: boolPtr(len(items) > 0)}
	}
}

func executeAdminListModels(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	purpose := strings.ToUpper(strings.TrimSpace(stringValue(params["purpose"])))
	kind := ""
	if purpose != "" {
		kind = adminPurposeKind(purpose)
		if kind == "" {
			return nil, rt.ValidationError("用途应为 CHAT / VISION / DOC_QA / EMBEDDING 之一")
		}
	}
	rows, err := dbPool().Query(toolContext(ctx), `
		SELECT m.id,m.provider_id,p.name,p.provider_key,m.model_id,m.display_name,m.kind,
		       m.context_window,m.dimensions,m.capabilities_json,m.enabled,m.created_at,m.updated_at
		FROM petrichor_ai_model m
		JOIN petrichor_ai_provider p ON p.id=m.provider_id
		WHERE m.user_id=$1 AND ($2='' OR m.kind=$2)
		ORDER BY p.name,m.model_id LIMIT 100`, ctx.UserID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	models := []map[string]any{}
	for rows.Next() {
		var id, providerID int64
		var providerName, providerKey, modelID, modelKind string
		var displayName, capabilitiesJSON *string
		var contextWindow, dimensions *int32
		var enabled bool
		var createdAt, updatedAt time.Time
		if rows.Scan(&id, &providerID, &providerName, &providerKey, &modelID, &displayName, &modelKind,
			&contextWindow, &dimensions, &capabilitiesJSON, &enabled, &createdAt, &updatedAt) != nil {
			continue
		}
		capabilities := any([]any{})
		if capabilitiesJSON != nil {
			_ = json.Unmarshal([]byte(*capabilitiesJSON), &capabilities)
		}
		models = append(models, map[string]any{
			"id": idStr(id), "providerId": idStr(providerID), "providerName": providerName, "providerKey": providerKey,
			"modelId": modelID, "displayName": displayName, "kind": modelKind, "contextWindow": contextWindow,
			"dimensions": dimensions, "capabilities": capabilities, "enabled": enabled,
			"createdAt": httpx.FormatISO(createdAt), "updatedAt": httpx.FormatISO(updatedAt),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	bindingRows, err := dbPool().Query(toolContext(ctx), `
		SELECT b.id,b.purpose,b.model_ref_id,b.options_json,b.updated_at,
		       m.model_id,m.display_name,m.context_window,m.dimensions,p.id,p.name,p.provider_key
		FROM petrichor_ai_binding b
		LEFT JOIN petrichor_ai_model m ON m.id=b.model_ref_id
		LEFT JOIN petrichor_ai_provider p ON p.id=m.provider_id
		WHERE b.user_id=$1 AND ($2='' OR b.purpose=$2)
		ORDER BY b.purpose`, ctx.UserID, purpose)
	if err != nil {
		return nil, err
	}
	defer bindingRows.Close()
	bindings := []map[string]any{}
	for bindingRows.Next() {
		var id, modelRefID int64
		var bindingPurpose string
		var optionsJSON, modelID, displayName, providerName, providerKey *string
		var contextWindow, dimensions *int32
		var providerID *int64
		var updatedAt time.Time
		if bindingRows.Scan(&id, &bindingPurpose, &modelRefID, &optionsJSON, &updatedAt,
			&modelID, &displayName, &contextWindow, &dimensions, &providerID, &providerName, &providerKey) != nil {
			continue
		}
		options := any(nil)
		if optionsJSON != nil {
			var parsed any
			if json.Unmarshal([]byte(*optionsJSON), &parsed) == nil {
				options = parsed
			}
		}
		bindings = append(bindings, map[string]any{
			"id": idStr(id), "purpose": bindingPurpose, "modelRefId": idStr(modelRefID),
			"modelId": modelID, "modelDisplayName": displayName, "providerId": optionalIDString(providerID),
			"providerName": providerName, "providerKey": providerKey, "contextWindow": contextWindow,
			"dimensions": dimensions, "options": options, "updatedAt": httpx.FormatISO(updatedAt),
		})
	}
	return map[string]any{"purpose": nullableString(purpose), "models": models, "bindings": bindings}, bindingRows.Err()
}

func executeAdminListAPIKeys(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	rows, err := dbPool().Query(toolContext(ctx), `
		SELECT id,name,key_prefix,scopes_json,expires_at,last_used_at,revoked_at,created_at,updated_at
		FROM petrichor_agent_api_key
		WHERE user_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())
		ORDER BY created_at DESC,id DESC LIMIT 50`, ctx.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var id int64
		var name, prefix, scopesJSON string
		var expiresAt, lastUsedAt, revokedAt *time.Time
		var createdAt, updatedAt time.Time
		if rows.Scan(&id, &name, &prefix, &scopesJSON, &expiresAt, &lastUsedAt, &revokedAt, &createdAt, &updatedAt) != nil {
			continue
		}
		items = append(items, map[string]any{
			"id": idStr(id), "name": name, "keyPrefix": prefix, "scopes": auth.ParseAgentScopes(&scopesJSON),
			"expiresAt": optionalTimeISO(expiresAt), "lastUsedAt": optionalTimeISO(lastUsedAt), "revokedAt": optionalTimeISO(revokedAt),
			"createdAt": httpx.FormatISO(createdAt), "updatedAt": httpx.FormatISO(updatedAt),
		})
	}
	return map[string]any{"items": items}, rows.Err()
}

func executeAdminGetPublicQA(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	enabled := true
	err := dbPool().QueryRow(toolContext(ctx), `SELECT public_qa_enabled FROM petrichor_site_appearance WHERE id=1`).Scan(&enabled)
	if err == pgx.ErrNoRows {
		// 与公开 loader 的缺省语义一致：没有配置行时默认开启。
		enabled = true
	} else if err != nil {
		return nil, err
	}
	return map[string]any{"publicQaEnabled": enabled}, nil
}

func executeAdminBindModel(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	purpose := strings.ToUpper(strings.TrimSpace(stringValue(params["purpose"])))
	kind := adminPurposeKind(purpose)
	if kind == "" {
		return nil, rt.ValidationError("用途应为 CHAT / VISION / DOC_QA / EMBEDDING 之一")
	}
	modelRefID := parseID(params["modelRefId"])
	if modelRefID <= 0 {
		return nil, rt.ValidationError("modelRefId 必须是正整数")
	}
	var modelID, modelKind, providerName, providerKey string
	var displayName *string
	var providerID int64
	err := dbPool().QueryRow(toolContext(ctx), `
		SELECT m.model_id,m.display_name,m.kind,p.id,p.name,p.provider_key
		FROM petrichor_ai_model m JOIN petrichor_ai_provider p ON p.id=m.provider_id
		WHERE m.id=$1 AND m.user_id=$2 LIMIT 1`, modelRefID, ctx.UserID).
		Scan(&modelID, &displayName, &modelKind, &providerID, &providerName, &providerKey)
	if err != nil {
		return nil, rt.ValidationError("模型不存在")
	}
	if modelKind != kind {
		return nil, rt.ValidationError("模型类型与用途不匹配")
	}
	var bindingID int64
	var updatedAt time.Time
	err = dbPool().QueryRow(toolContext(ctx), `
		INSERT INTO petrichor_ai_binding (user_id,purpose,model_ref_id,updated_at)
		VALUES ($1,$2,$3,now())
		ON CONFLICT (user_id,purpose) DO UPDATE SET model_ref_id=excluded.model_ref_id,updated_at=excluded.updated_at
		RETURNING id,updated_at`, ctx.UserID, purpose, modelRefID).Scan(&bindingID, &updatedAt)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"id": idStr(bindingID), "purpose": purpose, "modelRefId": idStr(modelRefID), "modelId": modelID,
		"modelDisplayName": displayName, "providerId": idStr(providerID), "providerName": providerName,
		"providerKey": providerKey, "updatedAt": httpx.FormatISO(updatedAt),
	}, nil
}

func adminPurposeKind(purpose string) string {
	switch purpose {
	case "CHAT", "VISION", "DOC_QA":
		return "LANGUAGE"
	case "EMBEDDING":
		return "EMBEDDING"
	}
	return ""
}

func optionalIDString(value *int64) any {
	if value == nil {
		return nil
	}
	return idStr(*value)
}

func optionalTimeISO(value *time.Time) any {
	if value == nil {
		return nil
	}
	return httpx.FormatISO(*value)
}
