package storage

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"petrichor/api/internal/config"
)

type interruptedUpload struct{}

func (interruptedUpload) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestStreamingUploadIsAtomicAndCleansTemporaryFiles(t *testing.T) {
	t.Chdir(t.TempDir())
	dir := t.TempDir()
	fixture := fmt.Sprintf("[database]\nurl = \"postgres://localhost/test_unused\"\n[storage]\nlocal_directory = %q\n", dir)
	if err := os.WriteFile("config.toml", []byte(fixture), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	const key = "uploads/7/source.pdf"
	ctx := context.Background()
	if err := WriteObjectStream(ctx, key, strings.NewReader("original"), "application/pdf", 8); err != nil {
		t.Fatal(err)
	}
	for _, body := range []io.Reader{strings.NewReader("oversized"), io.MultiReader(strings.NewReader("partial"), interruptedUpload{})} {
		if err := WriteObjectStream(ctx, key, body, "application/pdf", 8); err == nil {
			t.Fatal("应拒绝不完整/超限上传")
		}
		data, err := ReadLocalObject(key)
		if err != nil || string(data) != "original" {
			t.Fatalf("失败上传破坏原文件：%s %v", data, err)
		}
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := WriteObjectStream(canceled, key, strings.NewReader("new"), "application/pdf", 8); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(dir, "uploads/7/.petrichor-upload-*"))
	if err != nil || len(files) != 0 {
		t.Fatalf("遗留临时文件：%v %v", files, err)
	}
}
