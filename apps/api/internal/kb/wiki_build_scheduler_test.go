package kb

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"petrichor/api/internal/config"
)

func TestArticleKnowledgeBuildSchedulerDeduplicatesActiveArticle(t *testing.T) {
	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	var calls atomic.Int32
	scheduler := newArticleKnowledgeBuildScheduler(2, 8,
		func(ctx context.Context, _, _, articleID int64) (map[string]any, error) {
			calls.Add(1)
			started <- struct{}{}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return map[string]any{"articleId": articleID}, nil
			}
		})
	ctx, cancel := context.WithCancel(context.Background())
	wait := scheduler.start(ctx)
	defer func() {
		releaseOnce.Do(func() { close(release) })
		cancel()
		wait()
	}()

	first, err := scheduler.create(7, 11, 13)
	if err != nil {
		t.Fatalf("创建任务失败: %v", err)
	}
	second, err := scheduler.create(7, 11, 13)
	if err != nil {
		t.Fatalf("复用任务失败: %v", err)
	}
	firstID, _ := first["id"].(string)
	secondID, _ := second["id"].(string)
	if firstID == "" || secondID != firstID {
		t.Fatalf("重复文章没有复用任务: first=%q second=%q", firstID, secondID)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("任务没有被内存 Worker 领取")
	}
	releaseOnce.Do(func() { close(release) })
	completed := waitForArticleKnowledgeBuildStatus(t, scheduler, 7, firstID, "completed")
	result, _ := completed["result"].(map[string]any)
	if result["articleId"] != int64(13) {
		t.Fatalf("任务结果错误: %#v", result)
	}
	if calls.Load() != 1 {
		t.Fatalf("同一文章执行了 %d 次，期望 1 次", calls.Load())
	}
}

func TestArticleKnowledgeBuildSchedulerLimitsConcurrency(t *testing.T) {
	concurrency := config.DefaultKnowledgeBuildConcurrency
	started := make(chan struct{}, concurrency+1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	var active atomic.Int32
	var maximum atomic.Int32
	scheduler := newArticleKnowledgeBuildScheduler(concurrency, concurrency+1,
		func(ctx context.Context, _, _, articleID int64) (map[string]any, error) {
			current := active.Add(1)
			defer active.Add(-1)
			for {
				observed := maximum.Load()
				if current <= observed || maximum.CompareAndSwap(observed, current) {
					break
				}
			}
			started <- struct{}{}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-release:
				return map[string]any{"articleId": articleID}, nil
			}
		})
	ctx, cancel := context.WithCancel(context.Background())
	wait := scheduler.start(ctx)
	defer func() {
		releaseOnce.Do(func() { close(release) })
		cancel()
		wait()
	}()

	jobIDs := make([]string, 0, concurrency+1)
	for articleID := int64(1); articleID <= int64(concurrency+1); articleID++ {
		response, err := scheduler.create(1, 1, articleID)
		if err != nil {
			t.Fatalf("创建文章 %d 的任务失败: %v", articleID, err)
		}
		jobIDs = append(jobIDs, response["id"].(string))
	}
	for range concurrency {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatalf("前 %d 个任务没有并发启动", concurrency)
		}
	}
	select {
	case <-started:
		t.Fatalf("第 %d 个任务越过了并发上限", concurrency+1)
	case <-time.After(50 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	for _, jobID := range jobIDs {
		waitForArticleKnowledgeBuildStatus(t, scheduler, 1, jobID, "completed")
	}
	if maximum.Load() != int32(concurrency) {
		t.Fatalf("最大并发 = %d，期望 %d", maximum.Load(), concurrency)
	}
}

func TestKnowledgeBuildModelLimiterCapsAllArticles(t *testing.T) {
	originalSlots := knowledgeBuildModelSlots
	originalInvoker := ChatInvoker
	knowledgeBuildModelSlots = make(chan struct{}, 3)
	defer func() {
		knowledgeBuildModelSlots = originalSlots
		ChatInvoker = originalInvoker
	}()

	started := make(chan struct{}, 5)
	release := make(chan struct{})
	var active atomic.Int32
	var maximum atomic.Int32
	ChatInvoker = func(ctx context.Context, _ ChatRequest) (string, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			observed := maximum.Load()
			if current <= observed || maximum.CompareAndSwap(observed, current) {
				break
			}
		}
		started <- struct{}{}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-release:
			return "ok", nil
		}
	}

	var workers sync.WaitGroup
	for range 5 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			if _, err := invokeKnowledgeBuildChat(context.Background(), ChatRequest{}); err != nil {
				t.Errorf("invokeKnowledgeBuildChat() error = %v", err)
			}
		}()
	}
	for range 3 {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("全局模型并发额度没有被占满")
		}
	}
	select {
	case <-started:
		t.Fatal("模型调用越过了全局信号量上限")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	workers.Wait()
	if maximum.Load() != 3 {
		t.Fatalf("最大模型并发 = %d，期望 3", maximum.Load())
	}
}

func waitForArticleKnowledgeBuildStatus(
	t *testing.T,
	scheduler *articleKnowledgeBuildScheduler,
	userID int64,
	jobID string,
	want string,
) map[string]any {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		response := scheduler.loadOwned(userID, jobID)
		if response != nil && response["status"] == want {
			return response
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("任务 %s 没有进入 %s", jobID, want)
	return nil
}
