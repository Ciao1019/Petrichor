package storage

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"petrichor/api/internal/config"
)

func TestDeleteObjectBoundedSignedAndNoRedirectOrRetry(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Method != http.MethodDelete || r.URL.Query().Get("X-Amz-Signature") == "" {
			t.Error("未使用签名 DELETE")
		}
		switch r.URL.Path {
		case "/uploads/ok":
			w.WriteHeader(204)
		case "/uploads/missing":
			w.WriteHeader(404)
		case "/uploads/redirect":
			http.Redirect(w, r, "/outside", 307)
		case "/uploads/fail":
			w.WriteHeader(503)
		default:
			t.Error("DELETE 跟随重定向")
		}
	}))
	defer server.Close()
	configureTransferTest(t, server.URL)
	for _, key := range []string{"ok", "missing", "redirect", "fail"} {
		before := requests.Load()
		err := DeleteObjectBounded(context.Background(), "uploads/"+key)
		if (err == nil) != (key == "ok" || key == "missing") || requests.Load() != before+1 {
			t.Fatalf("%s err=%v requests=%d", key, err, requests.Load()-before)
		}
	}
}

func TestDeleteObjectBoundedCancellationAndDeadline(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		t.Run(fmt.Sprint(deadline), func(t *testing.T) {
			started := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				<-r.Context().Done()
			}))
			defer server.Close()
			configureTransferTest(t, server.URL)
			ctx, cancel := context.WithCancel(context.Background())
			if deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
			}
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- DeleteObjectBounded(ctx, "uploads/a") }()
			<-started
			if !deadline {
				cancel()
			}
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("DELETE 未遵守取消/截止时间")
			}
		})
	}
}

func TestDeleteObjectBoundedLocalBoundary(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	root := filepath.Join(dir, "objects")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	fixture := fmt.Sprintf("[database]\nurl = \"postgres://localhost/test_unused\"\n[storage]\nlocal_directory = %q\n", root)
	if err := os.WriteFile("config.toml", []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(dir, "keep")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(dir, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"../keep", outside, "escape/keep", ".", ""} {
		if err := DeleteObjectBounded(context.Background(), key); err == nil {
			t.Fatalf("允许越界/根目录删除: %q", key)
		}
	}
	if data, err := os.ReadFile(outside); err != nil || string(data) != "keep" {
		t.Fatal("根外对象被删除", err)
	}
	if err := SaveLocalObject("uploads/a", []byte("a")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := DeleteObjectBounded(ctx, "uploads/a"); !errors.Is(err, context.Canceled) || !LocalObjectExists("uploads/a") {
		t.Fatal("取消后仍删除", err)
	}
	for i := 0; i < 2; i++ {
		if err := DeleteObjectBounded(context.Background(), "s4key:uploads/a"); err != nil {
			t.Fatal(err)
		}
	}
	if LocalObjectExists("uploads/a") {
		t.Fatal("本地对象未删除")
	}
}
