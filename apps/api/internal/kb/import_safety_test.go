package kb

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/hibiken/asynq"

	"petrichor/api/internal/adminpanel"
	"petrichor/api/internal/config"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/taskqueue"
)

func importSafetyStore(t *testing.T) *taskqueue.DocumentImportStore {
	t.Helper()
	dir := t.TempDir()
	t.Chdir(dir)
	server := miniredis.RunT(t)
	fixture := fmt.Sprintf("[database]\nurl = \"postgres://localhost/test_unused\"\n[storage]\nlocal_directory = %q\n[cache.redis]\nurl = %q\n", dir, "redis://"+server.Addr())
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	if err := taskqueue.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = taskqueue.Close() })
	store, err := taskqueue.DocumentImports()
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func safetyImportJob(t *testing.T, store *taskqueue.DocumentImportStore, pages ...JobPageRow) *JobRow {
	t.Helper()
	job, err := store.Create(context.Background(), JobRow{UserID: 7, KnowledgeBaseID: 9, Title: "A", FileName: "a.pdf"}, pages...)
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func safetyPNG(t *testing.T) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestImportImageDownloadBoundsAndCancel(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), maxImportImageBytes+1)
	for _, chunked := range []bool{false, true} {
		for _, size := range []int{maxImportImageBytes - 1, maxImportImageBytes, maxImportImageBytes + 1} {
			t.Run(fmt.Sprintf("chunked=%v/size=%d", chunked, size), func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if chunked {
						w.(http.Flusher).Flush()
					} else {
						w.Header().Set("Content-Length", strconv.Itoa(size))
					}
					_, _ = w.Write(payload[:size])
				}))
				defer server.Close()
				data, err := downloadImportImage(context.Background(), server.URL)
				if size > maxImportImageBytes {
					if !errors.Is(err, storage.ErrObjectTooLarge) || data != nil {
						t.Fatalf("len=%d err=%v", len(data), err)
					}
				} else if err != nil || len(data) != size {
					t.Fatalf("len=%d err=%v", len(data), err)
				}
			})
		}
	}
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := downloadImportImage(ctx, server.URL); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("父取消未终止下载")
	}
}

func TestImportLocalImageBoundsRejectBeforeModel(t *testing.T) {
	importSafetyStore(t)
	old := VisionChatInvoker
	defer func() { VisionChatInvoker = old }()
	calls := 0
	VisionChatInvoker = func(context.Context, int64, *int64, string, string, VisionImageInput) (string, error) {
		calls++
		return "正文", nil
	}
	key := "uploads/7/page.png"
	job := &JobRow{UserID: 7}
	for _, data := range [][]byte{nil, []byte("not a png"), []byte("\x89PNG\r\n\x1a\n"), make([]byte, maxImportImageBytes+1)} {
		if err := storage.SaveLocalObject(key, data); err != nil {
			t.Fatal(err)
		}
		_, err := convertImportPage(context.Background(), job, key)
		if err == nil || workerErrorRetryable(err) || calls != 0 {
			t.Fatalf("err=%v calls=%d", err, calls)
		}
	}
	data := make([]byte, maxImportImageBytes)
	copy(data, safetyPNG(t))
	if err := storage.SaveLocalObject(key, data); err != nil {
		t.Fatal(err)
	}
	got, mime, err := fetchObjectBytes(context.Background(), key)
	if err != nil || len(got) != len(data) || mime != "image/png" {
		t.Fatalf("len=%d mime=%s err=%v", len(got), mime, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := fetchObjectBytes(ctx, key); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestImportMixedFailuresKeepPendingAndNeverReplaySuccess(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	key, text := "uploads/7/a.png", "成功页"
	job := safetyImportJob(t, store,
		JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &text},
		JobPageRow{PageNo: 2, Status: "failed", ExtractedBy: "ocr", ImageKey: &key, AttemptCount: 1},
		JobPageRow{PageNo: 3, Status: "pending", ExtractedBy: "ocr", ImageKey: &key, AttemptCount: 1, NextAttemptAt: time.Now().Add(time.Hour)})
	payload, _ := json.Marshal(taskqueue.DocumentImportPayload{JobID: job.ID})
	task := asynq.NewTask(taskqueue.TypeDocumentImport, payload)
	if err := HandleDocumentImportTask(ctx, task); err == nil || errors.Is(err, asynq.SkipRetry) {
		t.Fatalf("pending 必须保持调度: %v", err)
	}
	current, err := store.Get(ctx, job.ID)
	if err != nil || current.Status != "processing" {
		t.Fatalf("%+v %v", current, err)
	}
	ids, err := store.RunnableJobIDs(ctx)
	if err != nil || len(ids) != 1 {
		t.Fatalf("runnable=%v %v", ids, err)
	}
	if _, err := store.UpdatePage(ctx, job.ID, 3, func(p *JobPageRow) error { p.AttemptCount = p.MaxAttempts; return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := settleImportJobProgress(ctx, store, job.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := HandleDocumentImportTask(ctx, task); !errors.Is(err, asynq.SkipRetry) {
			t.Fatalf("终态不能自动重放: %v", err)
		}
	}
	pages, err := store.Pages(ctx, job.ID)
	if err != nil || pages[0].Status != "done" || derefStr(pages[0].Markdown) != text || pages[1].AttemptCount != 1 || pages[2].Status != "dead_letter" {
		t.Fatalf("%+v %v", pages, err)
	}
}

func TestImportCompleteCancelAndWorkerTerminalProtection(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	for _, status := range []string{"canceled", "completed"} {
		job := safetyImportJob(t, store, JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct"})
		if _, err := store.UpdateJob(ctx, job.ID, func(j *JobRow) error { j.Status = status; return nil }); err != nil {
			t.Fatal(err)
		}
		if err := processImportJobBackground(ctx, job.ID); err != nil {
			t.Fatal(err)
		}
		failImportJobWithContext(ctx, job.ID, "late failure")
		if _, _, err := refreshJobProgress(ctx, job.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := mutateImportRetry(ctx, store, job.ID, true, func(p []*JobPageRow) error { resetDocumentImportPage(p[0]); return nil }); err == nil {
			t.Fatal("终态不得重试")
		}
		if status == "canceled" {
			if err := completeDocumentImport(ctx, store, job.ID, 42); err == nil {
				t.Fatal("canceled 被覆盖")
			}
		} else {
			for i := 0; i < 2; i++ {
				if err := completeDocumentImport(ctx, store, job.ID, 42); err != nil {
					t.Fatal(err)
				}
			}
		}
		current, err := store.Get(ctx, job.ID)
		if err != nil || current.Status != status {
			t.Fatalf("%+v %v", current, err)
		}
	}
}

func TestImportAttachRetryAndAdminReplayReadiness(t *testing.T) {
	store := importSafetyStore(t)
	ctx := context.Background()
	text, key := "保留正文", "uploads/7/a.png"
	job := safetyImportJob(t, store,
		JobPageRow{PageNo: 1, Status: "done", ExtractedBy: "direct", Markdown: &text},
		JobPageRow{PageNo: 2, Status: "failed", ExtractedBy: "ocr"})
	for _, withImage := range []bool{false, true} {
		_, err := mutateImportRetry(ctx, store, job.ID, true, func(pages []*JobPageRow) error {
			resetDocumentImportPage(pages[1])
			if withImage {
				pages[1].ImageKey = &key
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		ids, err := store.RunnableJobIDs(ctx)
		if err != nil || (len(ids) == 1) != withImage {
			t.Fatalf("ids=%v %v", ids, err)
		}
		if _, err := store.UpdateJob(ctx, job.ID, func(j *JobRow) error { j.Status = "dead_letter"; return nil }); err != nil {
			t.Fatal(err)
		}
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodPost, "/admin/replay", strings.NewReader(fmt.Sprintf(`{"kind":"document_import","id":"%d"}`, job.ID)))
		c.Request.Header.Set("Content-Type", "application/json")
		adminpanel.AdminReplayDeadLetter(c)
		if w.Code != 200 {
			t.Fatalf("admin replay: %d %s", w.Code, w.Body.String())
		}
		ids, err = store.RunnableJobIDs(ctx)
		if err != nil || (len(ids) == 1) != withImage {
			t.Fatalf("admin ids=%v %v", ids, err)
		}
		pages, err := store.Pages(ctx, job.ID)
		if err != nil || pages[0].Status != "done" || derefStr(pages[0].Markdown) != text {
			t.Fatal("成功页不得重置")
		}
	}
}
