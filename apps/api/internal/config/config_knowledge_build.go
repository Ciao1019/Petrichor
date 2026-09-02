package config

import "fmt"

const (
	DefaultKnowledgeBuildConcurrency              = 8
	DefaultKnowledgeBuildQueueSize                = 128
	DefaultKnowledgeBuildQuestionBatchConcurrency = 8
	DefaultKnowledgeBuildPageBatchConcurrency     = 8
	DefaultKnowledgeBuildModelConcurrency         = 64
	MaxKnowledgeBuildModelConcurrency             = 128
)

// KnowledgeBuildConfig 控制 Asynq 文章 Worker、Redis 待处理软上限、阶段任务池与模型并发。
type KnowledgeBuildConfig struct {
	Concurrency              int
	QueueSize                int
	QuestionBatchConcurrency int
	PageBatchConcurrency     int
	ModelConcurrency         int
}

type knowledgeBuildFileConfig struct {
	Concurrency              int `toml:"concurrency"`
	QueueSize                int `toml:"queue_size"`
	QuestionBatchConcurrency int `toml:"question_batch_concurrency"`
	PageBatchConcurrency     int `toml:"page_batch_concurrency"`
	ModelConcurrency         int `toml:"model_concurrency"`
}

func normalizeKnowledgeBuild(raw knowledgeBuildFileConfig) (KnowledgeBuildConfig, error) {
	concurrency := defaultInt(raw.Concurrency, DefaultKnowledgeBuildConcurrency)
	queueSize := defaultInt(raw.QueueSize, DefaultKnowledgeBuildQueueSize)
	questionConcurrency := defaultInt(raw.QuestionBatchConcurrency, DefaultKnowledgeBuildQuestionBatchConcurrency)
	pageConcurrency := defaultInt(raw.PageBatchConcurrency, DefaultKnowledgeBuildPageBatchConcurrency)
	modelConcurrency := defaultInt(raw.ModelConcurrency, DefaultKnowledgeBuildModelConcurrency)

	if concurrency < 1 || concurrency > 32 {
		return KnowledgeBuildConfig{}, fmt.Errorf("knowledge_build.concurrency 必须在 1 到 32 之间")
	}
	if queueSize < 1 || queueSize > 4096 {
		return KnowledgeBuildConfig{}, fmt.Errorf("knowledge_build.queue_size 必须在 1 到 4096 之间")
	}
	if questionConcurrency < 1 || questionConcurrency > 32 {
		return KnowledgeBuildConfig{}, fmt.Errorf("knowledge_build.question_batch_concurrency 必须在 1 到 32 之间")
	}
	if pageConcurrency < 1 || pageConcurrency > 32 {
		return KnowledgeBuildConfig{}, fmt.Errorf("knowledge_build.page_batch_concurrency 必须在 1 到 32 之间")
	}
	if modelConcurrency < 1 || modelConcurrency > MaxKnowledgeBuildModelConcurrency {
		return KnowledgeBuildConfig{}, fmt.Errorf("knowledge_build.model_concurrency 必须在 1 到 %d 之间", MaxKnowledgeBuildModelConcurrency)
	}
	return KnowledgeBuildConfig{
		Concurrency:              concurrency,
		QueueSize:                queueSize,
		QuestionBatchConcurrency: questionConcurrency,
		PageBatchConcurrency:     pageConcurrency,
		ModelConcurrency:         modelConcurrency,
	}, nil
}

func defaultInt(value, fallback int) int {
	if value == 0 {
		return fallback
	}
	return value
}
