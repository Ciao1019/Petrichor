package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/agentapikey"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/ent/siteappearance"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/crypto"
)

func registerAdminTools() {
	registerTools([]ToolRegistration{
		{Name: "list_ai_configs", Domain: DomainAdmin, Risk: RiskRead, Description: "列出 AI 配置。", Factory: newListAIConfigsToolReg},
		{Name: "list_agent_api_keys", Domain: DomainAdmin, Risk: RiskRead, Description: "列出 Agent API Key。", Factory: newListAgentAPIKeysTool},
		{Name: "get_public_qa_setting", Domain: DomainAdmin, Risk: RiskRead, Description: "读取公开问答开关。", Factory: newGetPublicQASettingTool},
		{Name: "set_default_ai_config", Domain: DomainAdmin, Risk: RiskWrite, Description: "设置默认 AI 配置。", Factory: newSetDefaultAIConfigTool},
		{Name: "delete_ai_config", Domain: DomainAdmin, Risk: RiskDangerous, Description: "删除 AI 配置。", Factory: newDeleteAIConfigTool},
		{Name: "update_ai_config_credentials", Domain: DomainAdmin, Risk: RiskDangerous, Description: "更新 AI 配置密钥。", Factory: newUpdateAIConfigCredentialsTool},
		{Name: "revoke_agent_api_key", Domain: DomainAdmin, Risk: RiskDangerous, Description: "吊销 Agent API Key。", Factory: newRevokeAgentAPIKeyTool},
		{Name: "set_public_qa_enabled", Domain: DomainAdmin, Risk: RiskDangerous, Description: "设置公开问答开关。", Factory: newSetPublicQAEnabledTool},
	})
}

type listAIConfigsInput struct {
	ConfigType string `json:"configType,omitempty"`
}

func newListAIConfigsToolReg() tool.InvokableTool {
	t, err := utils.InferTool("list_ai_configs", "列出 AI 配置。", func(ctx context.Context, input *listAIConfigsInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		configType := strings.TrimSpace(input.ConfigType)
		if configType == "" {
			configType = "CHAT"
		}
		configType = strings.ToUpper(configType)
		switch configType {
		case "CHAT", "VISION", "EMBEDDING", "RERANK", "SPEECH":
		default:
			return nil, fmt.Errorf("configType 无效")
		}
		rows, err := client.AIModelConfig.Query().
			Where(aimodelconfig.UserIDEQ(userID), aimodelconfig.ConfigTypeEQ(configType)).
			Order(ent.Desc(aimodelconfig.FieldIsDefault), ent.Desc(aimodelconfig.FieldUpdatedAt), ent.Desc(aimodelconfig.FieldID)).
			Limit(50).
			All(ctx)
		if err != nil {
			return nil, err
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			item, err := assistantAIConfigDTO(row, cfgFrom(ctx))
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return map[string]any{"configType": configType, "items": items}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func newListAgentAPIKeysTool() tool.InvokableTool {
	t, err := utils.InferTool("list_agent_api_keys", "列出 Agent API Key。", func(ctx context.Context, _ *struct{}) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		rows, err := client.AgentAPIKey.Query().
			Where(
				agentapikey.UserIDEQ(userID), agentapikey.RevokedAtIsNil(),
				agentapikey.Or(agentapikey.ExpiresAtIsNil(), agentapikey.ExpiresAtGT(time.Now().UTC())),
			).
			Order(ent.Desc(agentapikey.FieldCreatedAt), ent.Desc(agentapikey.FieldID)).Limit(50).
			All(ctx)
		if err != nil {
			return nil, err
		}
		items := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			items = append(items, assistantAgentAPIKeyDTO(row))
		}
		return map[string]any{"items": items}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func newGetPublicQASettingTool() tool.InvokableTool {
	t, err := utils.InferTool("get_public_qa_setting", "读取公开问答开关。", func(ctx context.Context, _ *struct{}) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		row, err := client.SiteAppearance.Query().Where(siteappearance.IDEQ(1)).Only(ctx)
		if ent.IsNotFound(err) {
			return map[string]any{"publicQaEnabled": true}, nil
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"publicQaEnabled": row.PublicQaEnabled}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type configIDInput struct {
	ConfigID assistantID `json:"configId"`
}

func newSetDefaultAIConfigTool() tool.InvokableTool {
	t, err := utils.InferTool("set_default_ai_config", "设置默认 AI 配置。", func(ctx context.Context, input *configIDInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(input.ConfigID), "configId")
		if err != nil {
			return nil, err
		}
		cfg, err := client.AIModelConfig.Query().Where(aimodelconfig.IDEQ(id), aimodelconfig.UserIDEQ(userID)).Only(ctx)
		if err != nil {
			return nil, fmt.Errorf("配置不存在")
		}
		if _, err := client.AIModelConfig.Update().
			Where(aimodelconfig.UserIDEQ(userID), aimodelconfig.ConfigTypeEQ(cfg.ConfigType), aimodelconfig.IsDefaultEQ(true)).
			SetIsDefault(false).
			Save(ctx); err != nil {
			return nil, err
		}
		updated, err := cfg.Update().SetIsDefault(true).Save(ctx)
		if err != nil {
			return nil, err
		}
		return assistantAIConfigDTO(updated, cfgFrom(ctx))
	})
	if err != nil {
		panic(err)
	}
	return t
}

func assistantOptionalTime(value *time.Time) any {
	if value == nil {
		return nil
	}
	return value.UTC().Format(time.RFC3339Nano)
}

func assistantAgentAPIKeyDTO(row *ent.AgentAPIKey) map[string]any {
	var scopes []string
	if err := json.Unmarshal([]byte(row.ScopesJSON), &scopes); err != nil {
		scopes = []string{}
	}
	return map[string]any{
		"id": fmt.Sprintf("%d", row.ID), "name": row.Name, "keyPrefix": row.KeyPrefix,
		"scopes": scopes, "expiresAt": assistantOptionalTime(row.ExpiresAt),
		"lastUsedAt": assistantOptionalTime(row.LastUsedAt), "revokedAt": assistantOptionalTime(row.RevokedAt),
		"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano),
		"updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func assistantAIConfigDTO(row *ent.AIModelConfig, cfg *config.Config) (map[string]any, error) {
	plain := ""
	if row.APIKeyEnc != nil && strings.TrimSpace(*row.APIKeyEnc) != "" {
		raw := strings.TrimSpace(*row.APIKeyEnc)
		// 兼容 Go 重构早期曾写入的明文；形似正式密文的数据必须严格解密，
		// 防止配置错误时把密文误当作明文返回脱敏结果。
		if !assistantLooksLikeHexCipher(raw) {
			plain = raw
		} else {
			if cfg == nil || strings.TrimSpace(cfg.EncryptKey) == "" || strings.TrimSpace(cfg.EncryptSalt) == "" {
				return nil, fmt.Errorf("缺少 PETRICHOR_ENCRYPT_KEY/SALT，无法解密 API Key")
			}
			decoded, err := crypto.DecryptText(cfg.EncryptKey, cfg.EncryptSalt, raw)
			if err != nil {
				return nil, err
			}
			plain = decoded
		}
	}
	var masked any
	if plain != "" {
		if len([]rune(plain)) <= 8 {
			masked = "********"
		} else {
			runes := []rune(plain)
			masked = string(runes[:4]) + "********" + string(runes[len(runes)-4:])
		}
	}
	return map[string]any{
		"id": fmt.Sprintf("%d", row.ID), "configType": row.ConfigType, "protocol": row.Protocol,
		"name": row.Name, "baseUrl": row.BaseURL, "hasApiKey": plain != "", "apiKeyMasked": masked,
		"model": row.Model, "enabled": row.Enabled, "isDefault": row.IsDefault, "extraJson": row.ExtraJSON,
		"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano), "updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func assistantLooksLikeHexCipher(value string) bool {
	if len(value) < 64 || len(value)%2 != 0 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') && (char < 'A' || char > 'F') {
			return false
		}
	}
	return true
}

func newDeleteAIConfigTool() tool.InvokableTool {
	t, err := utils.InferTool("delete_ai_config", "删除 AI 配置。", func(ctx context.Context, input *configIDInput) (map[string]any, error) {
		if !confirmExecFrom(ctx) {
			return nil, fmt.Errorf("危险操作必须先通过 request_user_confirmation")
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(input.ConfigID), "configId")
		if err != nil {
			return nil, err
		}
		n, err := client.AIModelConfig.Delete().Where(aimodelconfig.IDEQ(id), aimodelconfig.UserIDEQ(userID)).Exec(ctx)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, fmt.Errorf("配置不存在")
		}
		return map[string]any{"configId": fmt.Sprintf("%d", id), "deleted": true}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type updateCredentialsInput struct {
	ConfigID assistantID `json:"configId"`
	APIKey   string      `json:"apiKey"`
	Enabled  *bool       `json:"enabled,omitempty"`
}

func newUpdateAIConfigCredentialsTool() tool.InvokableTool {
	t, err := utils.InferTool("update_ai_config_credentials", "更新 AI 配置密钥。", func(ctx context.Context, input *updateCredentialsInput) (map[string]any, error) {
		if !confirmExecFrom(ctx) {
			return nil, fmt.Errorf("危险操作必须先通过 request_user_confirmation")
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(input.ConfigID), "configId")
		if err != nil {
			return nil, err
		}
		cfg, err := client.AIModelConfig.Query().Where(aimodelconfig.IDEQ(id), aimodelconfig.UserIDEQ(userID)).Only(ctx)
		if err != nil {
			return nil, err
		}
		key := strings.TrimSpace(input.APIKey)
		if key == "" {
			return nil, fmt.Errorf("apiKey 不能为空")
		}
		c := cfgFrom(ctx)
		if c == nil || strings.TrimSpace(c.EncryptKey) == "" || strings.TrimSpace(c.EncryptSalt) == "" {
			return nil, fmt.Errorf("缺少 PETRICHOR_ENCRYPT_KEY/SALT，无法加密 API Key")
		}
		enc, err := crypto.EncryptText(c.EncryptKey, c.EncryptSalt, key)
		if err != nil {
			return nil, err
		}
		key = enc
		upd := cfg.Update().SetAPIKeyEnc(key)
		if input.Enabled != nil {
			upd.SetEnabled(*input.Enabled)
		}
		updated, err := upd.Save(ctx)
		if err != nil {
			return nil, err
		}
		return assistantAIConfigDTO(updated, cfgFrom(ctx))
	})
	if err != nil {
		panic(err)
	}
	return t
}

type apiKeyIDInput struct {
	APIKeyID assistantID `json:"apiKeyId"`
}

func newRevokeAgentAPIKeyTool() tool.InvokableTool {
	t, err := utils.InferTool("revoke_agent_api_key", "吊销 API Key。", func(ctx context.Context, input *apiKeyIDInput) (map[string]any, error) {
		if !confirmExecFrom(ctx) {
			return nil, fmt.Errorf("危险操作必须先通过 request_user_confirmation")
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		id, err := parsePositiveID(string(input.APIKeyID), "apiKeyId")
		if err != nil {
			return nil, err
		}
		row, err := client.AgentAPIKey.Query().Where(
			agentapikey.IDEQ(id), agentapikey.UserIDEQ(userID), agentapikey.RevokedAtIsNil(),
		).Only(ctx)
		if ent.IsNotFound(err) {
			return nil, fmt.Errorf("API Key 不存在")
		}
		if err != nil {
			return nil, err
		}
		updated, err := row.Update().SetRevokedAt(time.Now().UTC()).Save(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{"item": assistantAgentAPIKeyDTO(updated)}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type setPublicQAInput struct {
	Enabled bool `json:"enabled"`
}

func newSetPublicQAEnabledTool() tool.InvokableTool {
	t, err := utils.InferTool("set_public_qa_enabled", "设置公开问答开关。", func(ctx context.Context, input *setPublicQAInput) (map[string]any, error) {
		if !confirmExecFrom(ctx) || !isSuperAdmin(systemRoleFrom(ctx)) {
			return nil, fmt.Errorf("危险操作必须先通过 request_user_confirmation 且需超级管理员")
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		row, err := client.SiteAppearance.Query().Where(siteappearance.IDEQ(1)).Only(ctx)
		if ent.IsNotFound(err) {
			_, err = client.SiteAppearance.Create().SetID(1).SetPublicQaEnabled(input.Enabled).Save(ctx)
		} else if err == nil {
			_, err = row.Update().SetPublicQaEnabled(input.Enabled).Save(ctx)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"publicQaEnabled": input.Enabled}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}
