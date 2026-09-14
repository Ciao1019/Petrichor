package documentparse

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func fakeBinary(t *testing.T, body string) (string, string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("假二进制采用 Unix shebang；生产平台为 Linux")
	}
	if runtime.GOOS == "linux" {
		if _, err := executable("prlimit"); err != nil {
			t.Skip("宿主没有 prlimit；参数/流程由 fake runner 覆盖")
		}
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "fake-converter")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	return path, dir
}

func TestExecExactArgsEnvironmentAndNoShell(t *testing.T) {
	path, dir := fakeBinary(t, "printf '%s\\n' \"$@\"\nprintf '%s\\n' \"$LC_ALL\" \"$TMPDIR\" \"${DOCUMENTPARSE_TEST_SECRET-unset}\" \"${HTTP_PROXY-unset}\"")
	t.Setenv("DOCUMENTPARSE_TEST_SECRET", "never-pass-to-parser")
	t.Setenv("HTTP_PROXY", "http://must-not-inherit.invalid")
	args := []string{"--input", "a b;$(touch injected)", "--format", "docx"}
	data, err := (execRunner{}).run(context.Background(), path, dir, args, 4096)
	want := strings.Join(append(args, "C", dir, "unset", "unset", ""), "\n")
	if err != nil || string(data) != want {
		t.Fatalf("参数或环境: %q %v", data, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "injected")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("参数被当成 shell: %v", err)
	}
	wantArgs := []string{"--as=1073741824:1073741824", "--cpu=120:120", "--fsize=134217728:134217728", "--nofile=128:128", "--", path, "--version"}
	if got := resourceArgs(path, []string{"--version"}); !reflect.DeepEqual(got, wantArgs) {
		t.Fatalf("Linux 限制参数: %v", got)
	}
}

func TestExecBoundedOutputsAndNoErrorLeak(t *testing.T) {
	for _, tc := range []struct{ name, body, code string }{
		{"stdout", "while :; do printf '0123456789abcdef'; done", CodeResourceLimit},
		{"stderr", "while :; do printf 'secret-secret-secret' >&2; done", CodeResourceLimit},
		{"failure", "printf 'private source document' >&2; exit 7", CodeCommandFailed},
		{"oom-signal", "kill -KILL $$", CodeResourceLimit},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, dir := fakeBinary(t, tc.body)
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			data, err := (execRunner{}).run(ctx, path, dir, nil, 1024)
			mustCode(t, err, tc.code)
			if data != nil {
				t.Fatal("错误时不应暴露部分正文")
			}
			if tc.code == CodeResourceLimit && !IsPermanent(err) {
				t.Fatal("资源耗尽应永久失败")
			}
		})
	}
}

func TestExecCancellationAndProcessGroup(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		// 后代若逃过取消将写入文件；命令没有继承配置或访问外部目录。
		path, dir := fakeBinary(t, "( /bin/sleep 0.25; printf leaked > escaped ) &\nwait")
		ctx, cancel := context.WithCancel(context.Background())
		want := context.Canceled
		if deadline {
			cancel()
			ctx, cancel = context.WithTimeout(context.Background(), 50*time.Millisecond)
			want = context.DeadlineExceeded
		} else {
			timer := time.AfterFunc(50*time.Millisecond, cancel)
			defer timer.Stop()
		}
		start := time.Now()
		_, err := (execRunner{}).run(ctx, path, dir, nil, 1024)
		cancel()
		if !errors.Is(err, want) || time.Since(start) > time.Second || IsPermanent(err) {
			t.Fatalf("取消未及时停止: %v (%v)", err, time.Since(start))
		}
		time.Sleep(300 * time.Millisecond)
		if _, err := os.Stat(filepath.Join(dir, "escaped")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("子进程组未停止: %v", err)
		}
	}
}

func TestPrepareFakeBinaryProtocolAndTimeout(t *testing.T) {
	for _, tc := range []struct{ name, body, code string }{
		{"valid", `printf '%s' '{"ok":true,"markdown":"hello","engine":"anydoc"}'`, ""},
		{"multi-json", `printf '%s' '{"ok":true,"markdown":"hello","engine":"anydoc"}{}'`, CodeProtocol},
		{"business-error", `printf '%s' '{"ok":false,"code":"malformed"}'`, CodeMalformed},
		{"not-pdf-ocr", `printf '%s' '{"ok":false,"code":"needsOcr","pages":[1],"pageCount":1}'`, CodeUnsupported},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path, _ := fakeBinary(t, tc.body)
			dir := t.TempDir()
			emitted := 0
			err := Prepare(context.Background(), Config{Command: path}, "a.docx", []byte("x"), dir, nil, func(p Page) error {
				emitted++
				if p.Markdown == nil || *p.Markdown != "hello" {
					t.Fatalf("page: %+v", p)
				}
				return nil
			})
			if tc.code == "" {
				if err != nil || emitted != 1 {
					t.Fatalf("%v emitted %d", err, emitted)
				}
			} else {
				mustCode(t, err, tc.code)
				if emitted != 0 {
					t.Fatal("错误时仍然 emit")
				}
			}
			mustClean(t, dir)
		})
	}
	path, _ := fakeBinary(t, "exec /bin/sleep 30")
	dir := t.TempDir()
	err := Prepare(context.Background(), Config{Command: path, Timeout: 40 * time.Millisecond}, "a.docx", []byte("x"), dir, nil, noEmit(t))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Prepare 总超时: %v", err)
	}
	mustClean(t, dir)
}

func TestExecutableStrictLookup(t *testing.T) {
	dir := t.TempDir()
	plain := filepath.Join(dir, "not-executable")
	if err := os.WriteFile(plain, []byte("not executable"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"./converter", "../converter", "relative/converter", dir, plain, filepath.Join(dir, "missing"), "converter --version"} {
		_, err := executable(name)
		mustCode(t, err, CodeRuntimeUnavailable)
	}
	t.Setenv("PATH", dir)
	_, err := executable("missing")
	mustCode(t, err, CodeRuntimeUnavailable)
	if err := CheckRuntime(context.Background(), Config{Command: filepath.Join(dir, "missing")}); err == nil || IsPermanent(err) {
		t.Fatalf("缺失运行时不应永久化: %v", err)
	}
}

func TestCheckRuntimeAllToolsAndVersion(t *testing.T) {
	want := []string{"petrichor-doc-convert", "pdfinfo", "pdfseparate", "pdftoppm"}
	if runtime.GOOS == "linux" {
		want = append(want, "prlimit")
	}
	var seen []string
	runner := runnerFunc(func(ctx context.Context, cmd, dir string, args []string, limit int) ([]byte, error) {
		seen = append(seen, cmd)
		flag := "-v"
		if cmd == "petrichor-doc-convert" || cmd == "prlimit" {
			flag = "--version"
		}
		if !reflect.DeepEqual(args, []string{flag}) || !filepath.IsAbs(dir) {
			t.Fatalf("runtime 参数: %s %v", cmd, args)
		}
		return []byte("petrichor-doc-convert 1.0\n"), nil
	})
	if err := checkRuntime(context.Background(), Config{}, runner); err != nil || !reflect.DeepEqual(seen, want) {
		t.Fatalf("runtime tools: %v %v", seen, err)
	}
	for _, missing := range want {
		err := checkRuntime(context.Background(), Config{}, runnerFunc(func(ctx context.Context, cmd, _ string, _ []string, _ int) ([]byte, error) {
			if cmd == missing {
				return nil, failure(CodeRuntimeUnavailable)
			}
			return []byte("version"), nil
		}))
		mustCode(t, err, CodeRuntimeUnavailable)
	}
	for _, version := range [][]byte{nil, []byte(" \n"), {0xff}, []byte(strings.Repeat("x", 4097))} {
		err := checkRuntime(context.Background(), Config{}, runnerFunc(func(context.Context, string, string, []string, int) ([]byte, error) { return version, nil }))
		mustCode(t, err, CodeProtocol)
	}
}
