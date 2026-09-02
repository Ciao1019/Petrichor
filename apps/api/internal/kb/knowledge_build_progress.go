package kb

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/hibiken/asynq"
)

const (
	knowledgeBuildPhaseQueued     = "queued"
	knowledgeBuildPhasePreparing  = "preparing"
	knowledgeBuildPhaseAnalyzing  = "analyzing"
	knowledgeBuildPhaseTaxonomy   = "taxonomy"
	knowledgeBuildPhasePages      = "pages"
	knowledgeBuildPhasePersisting = "persisting"
	knowledgeBuildPhaseEmbedding  = "embedding"
	knowledgeBuildPhaseRetrying   = "retrying"
	knowledgeBuildPhaseCompleted  = "completed"
	knowledgeBuildPhaseFailed     = "failed"
)

type knowledgeBuildProgress struct {
	Percent   int       `json:"percent"`
	Phase     string    `json:"phase"`
	Message   string    `json:"message"`
	Completed int       `json:"completed,omitempty"`
	Total     int       `json:"total,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type knowledgeBuildProgressReporter func(knowledgeBuildProgress)
type knowledgeBuildProgressContextKey struct{}

func withKnowledgeBuildProgressReporter(ctx context.Context, reporter knowledgeBuildProgressReporter) context.Context {
	return context.WithValue(ctx, knowledgeBuildProgressContextKey{}, reporter)
}

func reportKnowledgeBuildProgress(ctx context.Context, percent int, phase, message string, completed, total int) {
	reporter, _ := ctx.Value(knowledgeBuildProgressContextKey{}).(knowledgeBuildProgressReporter)
	if reporter == nil {
		return
	}
	reporter(knowledgeBuildProgress{
		Percent: percent, Phase: phase, Message: message, Completed: completed, Total: total,
	})
}

// reportKnowledgeBuildProgressNote 只更新当前阶段文案，不改变已完成百分比。
func reportKnowledgeBuildProgressNote(ctx context.Context, message string) {
	reportKnowledgeBuildProgress(ctx, -1, "", message, 0, 0)
}

type knowledgeBuildTaskProgressWriter struct {
	mu        sync.Mutex
	task      *asynq.Task
	startedAt time.Time
	latest    knowledgeBuildProgress
}

func newKnowledgeBuildTaskProgressWriter(task *asynq.Task, startedAt time.Time) *knowledgeBuildTaskProgressWriter {
	return &knowledgeBuildTaskProgressWriter{
		task: task, startedAt: startedAt,
		latest: knowledgeBuildProgress{
			Percent: 0, Phase: knowledgeBuildPhaseQueued, Message: "等待 Worker 处理", UpdatedAt: startedAt,
		},
	}
}

func (writer *knowledgeBuildTaskProgressWriter) report(update knowledgeBuildProgress) {
	writer.mu.Lock()
	defer writer.mu.Unlock()

	if update.Percent < 0 {
		update.Percent = writer.latest.Percent
		update.Phase = writer.latest.Phase
		update.Completed = writer.latest.Completed
		update.Total = writer.latest.Total
	} else if update.Percent < writer.latest.Percent {
		// 问题生成与整文抽取并行，较慢分支不能把用户已看到的进度倒退。
		return
	}
	update.Percent = min(max(update.Percent, 0), 100)
	if update.Phase == "" {
		update.Phase = writer.latest.Phase
	}
	if update.Message == "" {
		update.Message = writer.latest.Message
	}
	update.UpdatedAt = time.Now().UTC()
	writer.latest = update

	snapshot := update
	if err := writeKnowledgeBuildTaskResult(writer.task, knowledgeBuildTaskResult{
		StartedAt: writer.startedAt,
		Progress:  &snapshot,
	}); err != nil {
		// 进度是可观测性增强，不能因为一次 Redis 快照写入失败中断知识构建。
		slog.Warn("知识构建进度写入 Asynq 失败", "err", err)
	}
}

func (writer *knowledgeBuildTaskProgressWriter) snapshot() knowledgeBuildProgress {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.latest
}

func normalizeKnowledgeBuildProgress(progress knowledgeBuildProgress) knowledgeBuildProgress {
	progress.Percent = min(max(progress.Percent, 0), 100)
	if progress.Phase == "" {
		progress.Phase = knowledgeBuildPhaseQueued
	}
	if progress.Message == "" {
		progress.Message = "等待 Worker 处理"
	}
	if progress.UpdatedAt.IsZero() {
		progress.UpdatedAt = time.Now().UTC()
	}
	return progress
}
