package storage

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"petrichor/api/internal/config"
)

func TestReadLocalObjectLimited(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	fixture := fmt.Sprintf("[database]\nurl = \"postgres://localhost/test_unused\"\n[storage]\nlocal_directory = %q\n", dir)
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := SaveLocalObject("uploads/a", []byte("1234")); err != nil {
		t.Fatal(err)
	}
	for _, limit := range []int64{3, 4, 5} {
		data, err := ReadLocalObjectLimited(ctx, "uploads/a", limit)
		if limit == 3 {
			if !errors.Is(err, ErrObjectTooLarge) || data != nil {
				t.Fatalf("limit=%d len=%d err=%v", limit, len(data), err)
			}
		} else if err != nil || string(data) != "1234" {
			t.Fatalf("limit=%d len=%d err=%v", limit, len(data), err)
		}
	}
	if _, err := ReadLocalObjectLimited(ctx, "../escape", 4); err == nil {
		t.Fatal("路径越界")
	}
	if _, err := ReadLocalObjectLimited(ctx, "uploads", 4); err == nil {
		t.Fatal("目录不可读")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := ReadLocalObjectLimited(canceled, "uploads/a", 4); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if data, err := ReadLocalObject("uploads/a"); err != nil || len(data) != 4 {
		t.Fatal("普通文档读取不受限")
	}
}
