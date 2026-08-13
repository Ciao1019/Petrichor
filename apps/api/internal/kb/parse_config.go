package kb

import (
	"encoding/json"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

// 解析引擎：决定正文从哪来。
//   - auto   优先服务端本地抽取，PDF 走 pdf-inspector；扫描页交给图像处理阶段兜底
//   - local  只做本地抽取，扫描页不调模型（省额度，扫描件会抽不出内容）
//   - scan   整份按扫描件处理，逐页交给多模态识别
const (
	ParseEngineAuto  = "auto"
	ParseEngineLocal = "local"
	ParseEngineScan  = "scan"
)

const (
	// 每个分片最多生成的问题数，与前端输入框上限一致。
	MaxQuestionsPerChunk = 10
	// 问题生成的自定义要求长度上限，与前端计数器一致。
	MaxQuestionInstructionsChars = 4000
)

// ChunkingOverride 是上传时对知识库分块配置的覆盖，nil 字段表示沿用知识库默认值。
type ChunkingOverride struct {
	Strategy          *string  `json:"strategy,omitempty"`
	ChunkSize         *int     `json:"chunkSize,omitempty"`
	ChunkOverlap      *int     `json:"chunkOverlap,omitempty"`
	Separators        []string `json:"separators,omitempty"`
	EnableParentChild *bool    `json:"enableParentChild,omitempty"`
	ParentChunkSize   *int     `json:"parentChunkSize,omitempty"`
	ChildChunkSize    *int     `json:"childChunkSize,omitempty"`
}

// MultimodalConfig 是图像处理配置：开启后扫描页/图片会交给多模态模型识别成可检索文本。
type MultimodalConfig struct {
	Enabled       bool    `json:"enabled"`
	ModelConfigID *string `json:"modelConfigId,omitempty"`
}

// QuestionGenerationConfig 是 AI 问题生成配置。
// 生成的问题会独立向量化，命中后回指源分片，用来提高召回率。
type QuestionGenerationConfig struct {
	Enabled bool `json:"enabled"`
	// 每个分片生成的问题数量（1-10）。
	QuestionCount int `json:"questionCount"`
	// 面向人群、场景与表达方式的自定义要求，追加在稳定的系统模板之后。
	CustomInstructions string `json:"customInstructions,omitempty"`
}

// DocumentParseConfig 是一次上传的完整解析配置，随文档存库，重新解析时沿用。
type DocumentParseConfig struct {
	Tags               []string                 `json:"tags,omitempty"`
	ParseEngine        string                   `json:"parseEngine"`
	Chunking           ChunkingOverride         `json:"chunking"`
	Multimodal         MultimodalConfig         `json:"multimodal"`
	QuestionGeneration QuestionGenerationConfig `json:"questionGeneration"`
	// PageImages 不是用户配的选项，而是上传时浏览器栅格化出来的整页图片。
	// 服务端没有 PDF 渲染能力，这些对象键是多模态识别唯一的输入，
	// 所以必须随文档存下来——否则重新解析时扫描件永远只能是空文档。
	PageImages []documentPageImage `json:"pageImages,omitempty"`
}

// DefaultDocumentParseConfig 是没有任何自定义时的配置：全部沿用知识库默认值。
func DefaultDocumentParseConfig() DocumentParseConfig {
	return DocumentParseConfig{
		ParseEngine:        ParseEngineAuto,
		QuestionGeneration: QuestionGenerationConfig{QuestionCount: 3},
	}
}

// NormalizeDocumentParseConfig 把外部传入的配置夹到合法范围内。
// 越界值一律回落到默认值而不是报错——上传不该因为一个滑块被拖过头而失败。
func NormalizeDocumentParseConfig(input *DocumentParseConfig) DocumentParseConfig {
	config := DefaultDocumentParseConfig()
	if input == nil {
		return config
	}

	switch strings.ToLower(strings.TrimSpace(input.ParseEngine)) {
	case ParseEngineLocal:
		config.ParseEngine = ParseEngineLocal
	case ParseEngineScan:
		config.ParseEngine = ParseEngineScan
	default:
		config.ParseEngine = ParseEngineAuto
	}

	config.Tags = normalizeDocumentTags(input.Tags)

	config.Chunking = input.Chunking
	if config.Chunking.ChunkSize != nil {
		value := maxInt(64, minInt(*config.Chunking.ChunkSize, 8192))
		config.Chunking.ChunkSize = &value
	}
	if config.Chunking.ChunkOverlap != nil {
		value := maxInt(0, minInt(*config.Chunking.ChunkOverlap, 2048))
		config.Chunking.ChunkOverlap = &value
	}
	if config.Chunking.ParentChunkSize != nil {
		value := clampChunkDimension(*config.Chunking.ParentChunkSize)
		config.Chunking.ParentChunkSize = &value
	}
	if config.Chunking.ChildChunkSize != nil {
		value := clampChunkDimension(*config.Chunking.ChildChunkSize)
		config.Chunking.ChildChunkSize = &value
	}
	if config.Chunking.Strategy != nil {
		value := strings.TrimSpace(*config.Chunking.Strategy)
		if value == "" {
			config.Chunking.Strategy = nil
		} else {
			config.Chunking.Strategy = &value
		}
	}

	config.Multimodal = MultimodalConfig{Enabled: input.Multimodal.Enabled}
	if input.Multimodal.ModelConfigID != nil && strings.TrimSpace(*input.Multimodal.ModelConfigID) != "" {
		value := strings.TrimSpace(*input.Multimodal.ModelConfigID)
		config.Multimodal.ModelConfigID = &value
	}
	// 按扫描件解析必然要调多模态，配置上直接对齐，免得后台阶段自相矛盾。
	if config.ParseEngine == ParseEngineScan {
		config.Multimodal.Enabled = true
	}

	config.QuestionGeneration = QuestionGenerationConfig{
		Enabled:            input.QuestionGeneration.Enabled,
		QuestionCount:      input.QuestionGeneration.QuestionCount,
		CustomInstructions: strings.TrimSpace(input.QuestionGeneration.CustomInstructions),
	}
	if config.QuestionGeneration.QuestionCount <= 0 {
		config.QuestionGeneration.QuestionCount = 3
	}
	config.QuestionGeneration.QuestionCount = minInt(config.QuestionGeneration.QuestionCount, MaxQuestionsPerChunk)
	if runes := []rune(config.QuestionGeneration.CustomInstructions); len(runes) > MaxQuestionInstructionsChars {
		config.QuestionGeneration.CustomInstructions = string(runes[:MaxQuestionInstructionsChars])
	}
	config.PageImages = normalizeDocumentPageImages(input.PageImages)
	return config
}

// normalizeDocumentTags 去空白、去重、限长，并保持用户给定的顺序。
func normalizeDocumentTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(tags))
	out := make([]string, 0, len(tags))
	for _, tag := range tags {
		value := strings.TrimSpace(tag)
		if value == "" {
			continue
		}
		if runes := []rune(value); len(runes) > 64 {
			value = string(runes[:64])
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
		if len(out) >= 20 {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// chunkingSettingsWithOverride 把上传时的覆盖项叠加到知识库默认分块配置上。
func chunkingSettingsWithOverride(kb *ent.KnowledgeBase, override ChunkingOverride) kbChunkingSettings {
	settings := chunkingSettingsFromKB(kb)
	if override.Strategy != nil {
		settings.Strategy = *override.Strategy
	}
	if override.ChunkSize != nil {
		settings.ChunkSize = *override.ChunkSize
	}
	if override.ChunkOverlap != nil {
		settings.ChunkOverlap = *override.ChunkOverlap
	}
	if override.Separators != nil {
		settings.Separators = override.Separators
	}
	if override.EnableParentChild != nil {
		settings.EnableParentChild = *override.EnableParentChild
	}
	if override.ParentChunkSize != nil {
		settings.ParentChunkSize = *override.ParentChunkSize
	}
	if override.ChildChunkSize != nil {
		settings.ChildChunkSize = *override.ChildChunkSize
	}
	return settings
}

// encodeDocumentParseConfig 把配置序列化成入库字符串。
func encodeDocumentParseConfig(config DocumentParseConfig) *string {
	raw, err := json.Marshal(config)
	if err != nil {
		return nil
	}
	value := string(raw)
	return &value
}

// decodeDocumentParseConfig 读回文档上保存的配置；缺失或损坏时回落到默认值。
func decodeDocumentParseConfig(raw *string) DocumentParseConfig {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return DefaultDocumentParseConfig()
	}
	var config DocumentParseConfig
	if err := json.Unmarshal([]byte(*raw), &config); err != nil {
		return DefaultDocumentParseConfig()
	}
	return NormalizeDocumentParseConfig(&config)
}
