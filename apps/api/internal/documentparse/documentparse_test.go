package documentparse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type runnerFunc func(context.Context, string, string, []string, int) ([]byte, error)

func (f runnerFunc) run(ctx context.Context, command, dir string, args []string, limit int) ([]byte, error) {
	return f(ctx, command, dir, args, limit)
}

func mustCode(t *testing.T, err error, code string) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("error = %v, want code %s", err, code)
	}
	if err.Error() != "documentparse: "+code {
		t.Fatalf("错误文本包含非稳定信息: %v", err)
	}
}

func successful(text string) []byte {
	data, _ := json.Marshal(struct {
		OK       bool   `json:"ok"`
		Markdown string `json:"markdown"`
		Engine   string `json:"engine"`
	}{true, text, "anydoc"})
	return data
}

func mustClean(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("临时文件未清理: %v, %v", entries, err)
	}
}

func noEmit(t *testing.T) func(Page) error {
	return func(page Page) error {
		t.Fatalf("不应 emit: %+v", page)
		return nil
	}
}

func TestDefaultConfigAndMarkdown(t *testing.T) {
	if got := DefaultConfig(); got.Command != "petrichor-doc-convert" || got.Timeout != 5*time.Minute {
		t.Fatalf("默认配置: %+v", got)
	}
	text := "\ufeff  # 原文\r\n\n  "
	for _, name := range []string{"foo.MD  ", "../$(secret).MARKDOWN\t"} {
		var pages []Page
		var stages []string
		err := Prepare(context.Background(), Config{Command: "/missing/no-parser"}, name, []byte(text), t.TempDir(), func(s string) {
			stages = append(stages, s)
		}, func(p Page) error { pages = append(pages, p); return nil })
		if err != nil || len(pages) != 1 || pages[0].PageNo != 1 || pages[0].Markdown == nil || *pages[0].Markdown != text || pages[0].ImagePath != "" {
			t.Fatalf("Markdown 原文未保留: %+v, %v", pages, err)
		}
		if !reflect.DeepEqual(stages, []string{"parsing"}) {
			t.Fatalf("stages = %v", stages)
		}
	}
}

func TestInputLimits(t *testing.T) {
	for _, tc := range []struct {
		name, file, code string
		source           []byte
	}{
		{"empty", "a.md", CodeMalformed, nil},
		{"unsupported", "a.html", CodeUnsupported, []byte("x")},
		{"invalid-utf8", "a.md", CodeMalformed, []byte{0xff}},
		{"unit-limit", "a.md", CodeResourceLimit, []byte(strings.Repeat("x", maxMarkdownUnit+1))},
		{"source-limit", "a.docx", CodeResourceLimit, make([]byte, maxSourceBytes+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			err := Prepare(context.Background(), Config{}, tc.file, tc.source, dir, nil, noEmit(t))
			mustCode(t, err, tc.code)
			if !IsPermanent(err) {
				t.Fatal("输入错误应为永久错误")
			}
			mustClean(t, dir)
		})
	}
	text := strings.Repeat("x", maxMarkdownUnit)
	if err := Prepare(context.Background(), Config{}, "a.md", []byte(text), t.TempDir(), nil, func(p Page) error { return nil }); err != nil {
		t.Fatalf("边界应通过: %v", err)
	}
}

func TestNonPDFExactArgsAndFilenameIsolation(t *testing.T) {
	formats := strings.Fields("doc docx docm ppt pps pot pptx pptm ppsx ppsm xls xlsx xlsm xlsb odt ods odp rtf epub csv")
	for _, format := range formats {
		t.Run(format, func(t *testing.T) {
			dir := t.TempDir()
			calls, emitted := 0, 0
			runner := runnerFunc(func(ctx context.Context, command, work string, args []string, limit int) ([]byte, error) {
				calls++
				want := []string{"--input", filepath.Join(work, "source."+format), "--format", format}
				if command != "fake-converter" || !reflect.DeepEqual(args, want) || limit != maxConverterOutput || !filepath.IsAbs(args[1]) {
					t.Fatalf("调用参数: %s %v (limit %d)", command, args, limit)
				}
				if !strings.HasPrefix(work, dir+string(os.PathSeparator)) {
					t.Fatalf("目录逃逸: %s", work)
				}
				data, err := os.ReadFile(args[1])
				if err != nil || string(data) != "input" {
					t.Fatalf("输入: %q, %v", data, err)
				}
				return successful(""), nil
			})
			err := prepare(context.Background(), Config{Command: "fake-converter"}, "../../evil ; $(touch injected)."+strings.ToUpper(format)+"  ", []byte("input"), dir, nil, func(p Page) error {
				emitted++
				if p.PageNo != 1 || p.Markdown == nil || *p.Markdown != "" || p.ImagePath != "" {
					t.Fatalf("空文档必须 direct: %+v", p)
				}
				return nil
			}, runner)
			if err != nil || calls != 1 || emitted != 1 {
				t.Fatalf("result %v calls %d emitted %d", err, calls, emitted)
			}
			mustClean(t, dir)
		})
	}
}

func TestCancellationTimeoutAndEmit(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := Prepare(ctx, Config{}, "a.md", []byte("x"), t.TempDir(), nil, noEmit(t))
	if !errors.Is(err, context.Canceled) || IsPermanent(err) {
		t.Fatalf("取消: %v", err)
	}
	for _, outer := range []bool{false, true} {
		dir := t.TempDir()
		ctx := context.Background()
		cfg := Config{Timeout: 20 * time.Millisecond}
		if outer {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, cfg.Timeout)
			defer cancel()
			cfg.Timeout = time.Minute
		}
		runner := runnerFunc(func(ctx context.Context, _, _ string, _ []string, _ int) ([]byte, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		})
		err = prepare(ctx, cfg, "a.docx", []byte("x"), dir, nil, noEmit(t), runner)
		if !errors.Is(err, context.DeadlineExceeded) || IsPermanent(err) {
			t.Fatalf("超时: %v", err)
		}
		mustClean(t, dir)
	}
	want := errors.New("caller-owned-upload-error")
	err = Prepare(context.Background(), Config{}, "a.md", []byte("x"), t.TempDir(), nil, func(Page) error { return want })
	if err != want {
		t.Fatalf("emit 错误必须原样返回: %v", err)
	}
	err = Prepare(context.Background(), Config{Timeout: 10 * time.Millisecond}, "a.md", []byte("x"), t.TempDir(), nil, func(Page) error {
		time.Sleep(30 * time.Millisecond)
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("emit 也计入总超时: %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	err = Prepare(ctx, Config{}, "a.docx", []byte("x"), t.TempDir(), func(string) { cancel() }, noEmit(t))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("stage 后应立即停止: %v", err)
	}
}

func TestErrorClassification(t *testing.T) {
	for _, code := range []string{CodeMalformed, CodeEncrypted, CodeUnsupported, CodeResourceLimit, CodeMissingPart, CodeIO, CodeProtocol, CodeRuntimeUnavailable, CodeCommandFailed} {
		want := code != CodeIO && code != CodeProtocol && code != CodeRuntimeUnavailable && code != CodeCommandFailed
		if IsPermanent(fmt.Errorf("wrapped: %w", failure(code))) != want {
			t.Fatalf("分类错误: %s", code)
		}
	}
	if IsPermanent(nil) || IsPermanent(context.DeadlineExceeded) || IsPermanent(errors.New("malformed")) {
		t.Fatal("不得按原文推断永久错误")
	}
}
