package taskqueue

import (
	"context"
	"sync"
)

// DocumentImportExecution 是实际执行读取/领取的围栏，不是在错误回调中重新读取的状态。
// 历史 payload 无需新增字段；每次 Asynq 技术重试都使用独立快照。
type DocumentImportExecution struct {
	JobID          int64
	ReplayCount    int32
	PrepareAttempt int32
	PrepareToken   string
}

func documentImportExecution(job *DocumentImportJob) DocumentImportExecution {
	return DocumentImportExecution{job.ID, job.ReplayCount, job.PrepareAttempt, job.PrepareToken}
}

func (e DocumentImportExecution) Matches(job *DocumentImportJob) bool {
	return e == documentImportExecution(job)
}

type documentImportExecutionKey struct{}
type documentImportExecutionState struct {
	mu       sync.Mutex
	value    DocumentImportExecution
	captured bool
	frozen   bool
}

// WithDocumentImportExecution 由 Asynq BaseContext 为每次执行创建，供处理器和错误回调共享。
func WithDocumentImportExecution(ctx context.Context) context.Context {
	return context.WithValue(ctx, documentImportExecutionKey{}, &documentImportExecutionState{})
}

func captureDocumentImportExecution(ctx context.Context, job *DocumentImportJob) {
	state, _ := ctx.Value(documentImportExecutionKey{}).(*documentImportExecutionState)
	if state == nil {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if !state.captured && !state.frozen {
		state.value, state.captured = documentImportExecution(job), true
	}
}

// AdvanceDocumentImportExecution 仅跟随本次执行已确认的领取/提交/失败写入，绝不跟随重读到的新重放。
func AdvanceDocumentImportExecution(ctx context.Context, before, after *DocumentImportJob) {
	state, _ := ctx.Value(documentImportExecutionKey{}).(*documentImportExecutionState)
	if state == nil {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.captured && !state.frozen && state.value.Matches(before) && before.ReplayCount == after.ReplayCount {
		state.value = documentImportExecution(after)
	}
}

// FailedDocumentImportExecution 冻结快照；Asynq 超时回调也不能被仍在退出的处理器改变。
func FailedDocumentImportExecution(ctx context.Context) (DocumentImportExecution, bool) {
	state, _ := ctx.Value(documentImportExecutionKey{}).(*documentImportExecutionState)
	if state == nil {
		return DocumentImportExecution{}, false
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	state.frozen = true
	return state.value, state.captured
}
