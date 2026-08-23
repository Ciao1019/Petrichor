package aicore

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

// 用途与模型类型（对应 config-logic.ts）。
const (
	PurposeChat     = "CHAT"
	PurposeVision   = "VISION"
	PurposeDocQA    = "DOC_QA"
	PurposeEmbedding = "EMBEDDING"
)

var purposeLabels = map[string]string{
	PurposeChat:      "对话",
	PurposeVision:    "多模态",
	PurposeDocQA:     "文档库问答",
	PurposeEmbedding: "向量嵌入",
}

func modelKindForPurpose(purpose string) string {
	if purpose == PurposeEmbedding {
		return "EMBEDDING"
	}
	return "LANGUAGE"
}

// GenerationOptions 绑定级生成参数。
type GenerationOptions struct {
	Temperature            *float64 `json:"temperature"`
	MaxTokens              *int64   `json:"maxTokens"`
	Thinking               *string  `json:"thinking"` // enabled/disabled
	DisableThinkingForTools *bool   `json:"disableThinkingForTools"`
}

// RuntimeConfig 模型工厂入参（对应 ProviderRuntimeConfig）。
type RuntimeConfig struct {
	ProviderKey string
	BaseURL     string
	APIKey      string
	Extra       map[string]string
	Headers     map[string]string
	Quirks      Quirks
}

// ResolvedModel 解析结果。
type ResolvedModel struct {
	ModelID    int64
	UserID     int64
	ModelRef   string // ai_model.model_id
	Kind       string
	ContextWindow int64
	ProviderID int64
	ProviderKey string
	CredentialID int64
	Options    GenerationOptions
	Runtime    RuntimeConfig
}

// ResolveModelForPurpose 复刻 resolution.ts：优先 modelRefId（历史重放），回落用途绑定。
func ResolveModelForPurpose(ctx context.Context, userID int64, purpose string, modelRefID *int64) (*ResolvedModel, error) {
	if modelRefID != nil && *modelRefID > 0 {
		if r := loadResolvedModel(ctx, userID, *modelRefID, purpose); r != nil {
			return r, nil
		}
	}
	var modelRef int64
	var optionsJSON *string
	err := db.Pool().QueryRow(ctx,
		`SELECT model_ref_id, options_json FROM petrichor_ai_binding WHERE user_id = $1 AND purpose = $2 LIMIT 1`,
		userID, purpose).Scan(&modelRef, &optionsJSON)
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, httpx.BadRequest("未配置" + purposeLabels[purpose] + "模型，请前往「模型配置 → 用途绑定」为" + purposeLabels[purpose] + "选择一个模型")
		}
		return nil, err
	}
	resolved := loadResolvedModel(ctx, userID, modelRef, purpose)
	if resolved == nil {
		return nil, httpx.BadRequest(purposeLabels[purpose] + "绑定的模型已失效（模型或供应商被删除、停用），请重新绑定")
	}
	resolved.Options = parseGenerationOptions(optionsJSON)
	return resolved, nil
}

func loadResolvedModel(ctx context.Context, userID, modelRefID int64, purpose string) *ResolvedModel {
	var (
		m           ModelRow
		p           ProviderRow
		c           CredentialRow
	)
	err := db.Pool().QueryRow(ctx, `
		SELECT m.id, m.user_id, m.model_id, m.kind, COALESCE(m.context_window,0), m.enabled,
		       p.id, p.provider_key, COALESCE(p.base_url,''), p.enabled,
		       c.id, c.api_key_enc, c.extra_enc
		FROM petrichor_ai_model m
		JOIN petrichor_ai_provider p ON p.id = m.provider_id
		JOIN petrichor_ai_credential c ON c.id = p.credential_id
		WHERE m.id = $1 AND m.user_id = $2
		LIMIT 1`, modelRefID, userID).
		Scan(&m.ID, &m.UserID, &m.ModelID, &m.Kind, &m.ContextWindow, &m.Enabled,
			&p.ID, &p.ProviderKey, &p.BaseURLStr, &p.Enabled,
			&c.ID, &c.APIKeyEnc, &c.ExtraEnc)
	if err != nil || !m.Enabled || !p.Enabled || m.Kind != modelKindForPurpose(purpose) {
		return nil
	}
	return &ResolvedModel{
		ModelID: m.ID, UserID: m.UserID, ModelRef: m.ModelID, Kind: m.Kind,
		ContextWindow: m.ContextWindow,
		ProviderID: p.ID, ProviderKey: p.ProviderKey, CredentialID: c.ID,
		Options:    parseGenerationOptions(nil),
		Runtime: BuildRuntimeConfig(p.ProviderKey, p.BaseURLStr, DecodeApiKey(deref(c.APIKeyEnc)), DecodeExtra(deref(c.ExtraEnc)), nil, Quirks{}),
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// providerHeadersJson 供应商自定义头。
func providerHeadersJSON(ctx context.Context, providerID int64) *string {
	var h *string
	_ = db.Pool().QueryRow(ctx, `SELECT headers_json FROM petrichor_ai_provider WHERE id = $1`, providerID).Scan(&h)
	return h
}

type ModelRow struct {
	ID            int64
	UserID        int64
	ModelID       string
	Kind          string
	ContextWindow int64
	Enabled       bool
}

type ProviderRow struct {
	ID          int64
	ProviderKey string
	BaseURLStr  string
	Enabled     bool
}

type CredentialRow struct {
	ID        int64
	APIKeyEnc *string
	ExtraEnc  *string
}

func parseGenerationOptions(raw *string) GenerationOptions {
	opts := GenerationOptions{DisableThinkingForTools: boolPtr(true)}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return opts
	}
	_ = jsonParse(*raw, &opts)
	if opts.DisableThinkingForTools == nil {
		opts.DisableThinkingForTools = boolPtr(true)
	}
	return opts
}

func boolPtr(v bool) *bool { return &v }

// BuildRuntimeConfig 拼装运行时配置。
func BuildRuntimeConfig(providerKey, baseURL, apiKey string, extra map[string]string, headers map[string]string, quirks Quirks) RuntimeConfig {
	return RuntimeConfig{
		ProviderKey: providerKey,
		BaseURL:     strings.TrimRight(baseURL, "/"),
		APIKey:      apiKey,
		Extra:       extra,
		Headers:     headers,
		Quirks:      quirks,
	}
}

func parseStringMap(raw *string) map[string]string {
	out := map[string]string{}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return out
	}
	_ = jsonParse(*raw, &out)
	return out
}
