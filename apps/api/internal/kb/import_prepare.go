package kb

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"petrichor/api/internal/config"
	"petrichor/api/internal/documentparse"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

const maxImportSourceBytes = 100 << 20
const importSourceDownloadTimeout = 120 * time.Second

// 测试可替换解析器/提交响应；生产直接使用服务端解析器和 Redis 原子提交。
var prepareImportDocument = documentparse.Prepare
var commitImportPreparation = (*taskqueue.DocumentImportStore).CommitPreparation

func prepareImportJob(ctx context.Context, store *taskqueue.DocumentImportStore, job *JobRow) (bool, error) {
	if !taskqueue.DocumentImportNeedsPreparation(job) {
		return true, nil
	}
	parser := config.Get().DocumentImport.Parser
	cfg := documentparse.DefaultConfig()
	if parser.Command != "" {
		cfg.Command = parser.Command
	}
	if parser.Timeout > 0 {
		cfg.Timeout = parser.Timeout
	}
	lease := importSourceDownloadTimeout + cfg.Timeout + time.Minute
	claim, err := store.ClaimPreparation(ctx, job.ID, lease)
	if preparationObsolete(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	taskqueue.AdvanceDocumentImportExecution(ctx, job, claim)
	if documentImportWorkerStopped(claim) {
		return false, nil
	}
	var imageKeys []string
	published := false
	defer func() {
		if !published && len(imageKeys) > 0 {
			cleanupImportPreparationImages(ctx, store, claim, imageKeys)
		}
	}()
	// 为失败状态写入留出余量，下载/子进程/上传的所有截止时间均早于领取租约。
	workCtx, cancel := context.WithDeadline(ctx, claim.PrepareLeaseUntil.Add(-30*time.Second))
	stopped := watchImportPreparation(workCtx, cancel, store, claim)
	pages, prepareErr := buildImportPagePlan(workCtx, store, claim, cfg, &imageKeys)
	cancel()
	<-stopped
	if prepareErr == nil {
		prepareErr = ctx.Err()
	}
	if prepareErr == nil {
		commitCtx, stop := context.WithDeadline(ctx, claim.PrepareLeaseUntil.Add(-10*time.Second))
		defer stop()
		prepareErr = commitImportPreparation(store, commitCtx, claim.ID, claim.PrepareToken, pages)
		if prepareErr == nil {
			published = true
			advanceFinishedPreparationExecution(ctx, claim)
			return true, nil
		}
	}
	if preparationObsolete(prepareErr) {
		return false, nil
	}
	status := preparationFailureStatus(prepareErr, claim.PrepareAttempt, claim.PrepareMaxAttempts)
	message := "文档准备失败，请稍后重试"
	if status == "failed" {
		message = "原文件损坏、加密、超限或解析页计划无效，请检查后重新导入"
	}
	if status == "dead_letter" {
		message = "文档准备多次失败，已进入死信队列"
	}
	next := time.Now().UTC()
	if status == "pending" {
		next = next.Add(workerRetryDelay(int(claim.PrepareAttempt), fmt.Sprintf("prepare-%d", claim.ID)))
	}
	// 父取消也记为有界重试，但业务取消/重放后的旧 token 不能写回。
	failureCtx, stop := context.WithDeadline(context.WithoutCancel(ctx), minTime(time.Now().Add(5*time.Second), claim.PrepareLeaseUntil.Add(-time.Second)))
	defer stop()
	err = store.FailPreparation(failureCtx, claim.ID, claim.PrepareToken, status, message, next)
	if err == nil {
		advanceFinishedPreparationExecution(ctx, claim)
	}
	if preparationObsolete(err) {
		return false, nil
	}
	return false, err
}

func advanceFinishedPreparationExecution(ctx context.Context, claim *JobRow) {
	finished := *claim
	finished.PrepareToken = ""
	taskqueue.AdvanceDocumentImportExecution(ctx, claim, &finished)
}

// 失败清理最多占用 15 秒，脱离父取消；每个对象只尝试一次。
// Redis/网络异常时保守保留，并记录精确 token/keys，便于按日志补偿，绝不盲删已发布页图。
func cleanupImportPreparationImages(ctx context.Context, store *taskqueue.DocumentImportStore, claim *JobRow, keys []string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	referenced := errors.New("准备图片已发布")
	owned := make(map[string]bool, len(keys))
	for _, key := range keys {
		owned[key] = true
	}
	_, err := store.UpdateJobPages(ctx, claim.ID, func(current *JobRow, pages []*JobPageRow) error {
		for _, page := range pages {
			if taskqueue.DocumentImportOwnsImage(page, owned) {
				return referenced
			}
		}
		// 与引用检查同一 WATCH 撤销 token，阻止响应不明的迟到 EXEC 随后发布。
		if current.PrepareToken == claim.PrepareToken {
			current.PrepareToken, current.PrepareLeaseUntil = "", time.Time{}
		}
		return nil
	})
	if errors.Is(err, referenced) {
		return
	}
	if errors.Is(err, taskqueue.ErrDocumentImportEnded) {
		// sealed 任务不能再发布，但取消/完成之前可能已提交完整页计划。
		var pages []JobPageRow
		pages, err = store.Pages(ctx, claim.ID)
		for _, page := range pages {
			if taskqueue.DocumentImportOwnsImage(&page, owned) {
				return
			}
		}
	}
	if err != nil && !errors.Is(err, taskqueue.ErrDocumentImportNotFound) {
		slog.Warn("文档准备图片清理待补偿", "jobId", claim.ID, "prepareToken", claim.PrepareToken, "imageKeys", keys, "reason", "引用确认失败", "err", err)
		return
	}
	for i, key := range keys {
		if ctx.Err() != nil {
			slog.Warn("文档准备图片清理待补偿", "jobId", claim.ID, "prepareToken", claim.PrepareToken, "imageKeys", keys[i:], "reason", "清理超时")
			return
		}
		if err := storage.DeleteObjectBounded(ctx, key); err != nil {
			slog.Warn("文档准备图片清理待补偿", "jobId", claim.ID, "prepareToken", claim.PrepareToken, "imageKeys", []string{key}, "reason", "删除失败", "err", err)
		}
	}
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func preparationObsolete(err error) bool {
	return errors.Is(err, taskqueue.ErrDocumentImportPrepareStale) || errors.Is(err, taskqueue.ErrDocumentImportEnded) || errors.Is(err, taskqueue.ErrDocumentImportNotFound)
}

func preparationFailureStatus(err error, attempt, maxAttempts int32) string {
	if documentparse.IsPermanent(err) || errors.Is(err, taskqueue.ErrDocumentImportPreparePlan) || errors.Is(err, storage.ErrObjectTooLarge) {
		return "failed"
	}
	var objectErr *storage.ObjectHTTPError
	if errors.As(err, &objectErr) {
		err = &httpx.HttpError{Status: objectErr.Status, Message: "对象传输失败"}
	}
	return workerFailureStatus(err, attempt, maxAttempts)
}

// 除 Asynq CancelProcessing 外轮询业务围栏，取消/删除/重放即停止子进程和上传。
func watchImportPreparation(ctx context.Context, cancel context.CancelFunc, store *taskqueue.DocumentImportStore, claim *JobRow) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				latest, err := store.Get(ctx, claim.ID)
				if err != nil || documentImportWorkerStopped(latest) || latest.PrepareToken != claim.PrepareToken || !latest.PrepareLeaseUntil.After(time.Now()) {
					cancel()
					return
				}
			}
		}
	}()
	return done
}

func buildImportPagePlan(ctx context.Context, store *taskqueue.DocumentImportStore, job *JobRow, cfg documentparse.Config, imageKeys *[]string) ([]JobPageRow, error) {
	if err := validateImportObjectKey(job.UserID, derefStr(job.SourceKey)); err != nil {
		return nil, err
	}
	downloadCtx, stop := context.WithTimeout(ctx, importSourceDownloadTimeout)
	source, err := storage.ReadObjectLimited(downloadCtx, *job.SourceKey, maxImportSourceBytes)
	stop()
	if err != nil {
		return nil, err
	}
	workDir, err := os.MkdirTemp("", "petrichor-document-import-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(workDir)
	parseCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	var mu sync.Mutex
	var callbackErr error
	pages := make([]JobPageRow, 0)
	totalMarkdown := 0
	err = prepareImportDocument(parseCtx, cfg, job.FileName, source, workDir, func(stage string) {
		mu.Lock()
		defer mu.Unlock()
		if callbackErr != nil {
			return
		}
		callbackErr = store.SetPreparationStage(parseCtx, job.ID, job.PrepareToken, stage)
		if callbackErr != nil {
			cancel()
		}
	}, func(page documentparse.Page) error {
		mu.Lock()
		defer mu.Unlock()
		if callbackErr != nil {
			return callbackErr
		}
		row, emitErr := prepareImportPage(parseCtx, job, workDir, page, len(pages)+1, &totalMarkdown, imageKeys)
		if emitErr != nil {
			callbackErr = emitErr
			cancel()
			return emitErr
		}
		pages = append(pages, row)
		return nil
	})
	mu.Lock()
	defer mu.Unlock()
	if callbackErr != nil {
		return nil, callbackErr
	}
	if err != nil {
		return nil, err
	}
	if err := parseCtx.Err(); err != nil {
		return nil, err
	}
	return pages, nil
}
