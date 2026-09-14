package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"petrichor/api/internal/config"
)

func configureTransferTest(t *testing.T, endpoint string) {
	t.Helper()
	dir := t.TempDir()
	t.Chdir(dir)
	fixture := fmt.Sprintf("[database]\nurl = \"postgres://localhost/test_unused\"\n[storage.s3]\nendpoint = %q\nbucket = \"127.0.0.1\"\naccess_key_id = \"test-only\"\nsecret_access_key = \"test-only\"\n", endpoint)
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
}

func TestBoundedObjectPresignedGetPutAndLimits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("X-Amz-Signature") == "" {
			t.Error("未使用配置内预签名")
		}
		if r.Method == "PUT" {
			data, err := io.ReadAll(r.Body)
			if err != nil || string(data) != "image" || r.Header.Get("Content-Type") != "image/png" {
				t.Errorf("PUT内容错误: %s %v", data, err)
			}
			w.WriteHeader(204)
			return
		}
		switch r.URL.Path {
		case "/uploads/7/chunked":
			w.(http.Flusher).Flush()
			_, _ = w.Write([]byte(strings.Repeat("x", 33)))
		case "/uploads/7/large":
			w.Header().Set("Content-Length", "104857601")
			w.WriteHeader(200)
		case "/uploads/7/redirect":
			http.Redirect(w, r, "/outside", 302)
		case "/outside":
			t.Error("对象传输跟随了重定向")
		default:
			_, _ = w.Write([]byte(strings.Repeat("x", 32)))
		}
	}))
	defer server.Close()
	configureTransferTest(t, server.URL)
	ctx := context.Background()
	data, err := ReadObjectLimited(ctx, "uploads/7/ok", 32)
	if err != nil || len(data) != 32 {
		t.Fatalf("%d %v", len(data), err)
	}
	for _, key := range []string{"uploads/7/chunked", "uploads/7/large"} {
		if _, err := ReadObjectLimited(ctx, key, 32); !errors.Is(err, ErrObjectTooLarge) {
			t.Fatal(key, err)
		}
	}
	if _, err := ReadObjectLimited(ctx, "uploads/7/redirect", 32); err == nil {
		t.Fatal("重定向应拒绝")
	}
	if err := WriteObjectBounded(ctx, "uploads/7/image", []byte("image"), "image/png", 5); err != nil {
		t.Fatal(err)
	}
	if err := WriteObjectBounded(ctx, "uploads/7/image", []byte("image"), "image/png", 4); !errors.Is(err, ErrObjectTooLarge) {
		t.Fatal(err)
	}
}

func TestBoundedObjectTransferCancellation(t *testing.T) {
	for _, method := range []string{"GET", "PUT"} {
		t.Run(method, func(t *testing.T) {
			started := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				w.(http.Flusher).Flush()
				close(started)
				<-r.Context().Done()
			}))
			defer server.Close()
			configureTransferTest(t, server.URL)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				var err error
				if method == "GET" {
					_, err = ReadObjectLimited(ctx, "uploads/7/a", 32)
				} else {
					err = WriteObjectBounded(ctx, "uploads/7/a", []byte("a"), "image/png", 32)
				}
				done <- err
			}()
			<-started
			cancel()
			select {
			case err := <-done:
				// PUT 收到成功响应头后可以成功返回，服务端仍必须观察到取消或 Body.Close。
				if method == "GET" && !errors.Is(err, context.Canceled) {
					t.Fatal(err)
				}
			case <-time.After(time.Second):
				t.Fatal("对象传输未响应取消")
			}
		})
	}
}
