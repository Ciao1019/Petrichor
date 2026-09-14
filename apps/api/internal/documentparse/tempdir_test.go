package documentparse

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func sparseFile(t *testing.T, path string, size int64) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if err := file.Truncate(size); err != nil {
		t.Fatal(err)
	}
}

func taskForTest(t *testing.T, dir string) *taskDirectory {
	t.Helper()
	task, err := openTaskDirectory(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { task.root.Close() })
	return task
}

func TestTaskDirectoryWholeTaskByteBoundary(t *testing.T) {
	dir := t.TempDir()
	unit := filepath.Join(dir, "unit")
	if err := os.Mkdir(unit, 0700); err != nil {
		t.Fatal(err)
	}
	sparseFile(t, filepath.Join(dir, "source.pdf"), 100<<20)
	sparseFile(t, filepath.Join(unit, "page-1.pdf"), 100<<20)
	extra := filepath.Join(unit, "extra")
	sparseFile(t, extra, maxTaskBytes-(200<<20))
	task := taskForTest(t, dir)
	if err := task.check(context.Background()); err != nil {
		t.Fatalf("256 MiB 边界应允许: %v", err)
	}
	if err := os.Truncate(extra, maxTaskBytes-(200<<20)+1); err != nil {
		t.Fatal(err)
	}
	mustCode(t, task.check(context.Background()), CodeResourceLimit)
}

func TestTaskDirectoryEntryBoundaryAndCancellation(t *testing.T) {
	dir := t.TempDir()
	unit := filepath.Join(dir, "unit")
	if err := os.Mkdir(unit, 0700); err != nil {
		t.Fatal(err)
	}
	for i := 1; i < maxTaskEntries; i++ {
		base := dir
		if i%2 == 0 {
			base = unit
		}
		sparseFile(t, filepath.Join(base, fmt.Sprint(i)), 0)
	}
	task := taskForTest(t, dir)
	if err := task.check(context.Background()); err != nil {
		t.Fatalf("64 条目边界应允许: %v", err)
	}
	for i := maxTaskEntries; i < 512; i++ {
		sparseFile(t, filepath.Join(unit, fmt.Sprint(i)), 0)
	}
	start := time.Now()
	mustCode(t, task.check(context.Background()), CodeResourceLimit)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := task.check(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("目录检查忽略取消: %v", err)
	}
	if time.Since(start) > time.Second {
		t.Fatal("目录扫描未及时结束")
	}
}

func TestTaskDirectoryRejectsUnboundedShapes(t *testing.T) {
	for _, name := range []string{"nested", "other-directory", "directory-link", "file-link", "cycle-link"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			var err error
			switch name {
			case "nested":
				err = os.MkdirAll(filepath.Join(dir, "unit", "unit", "deeper"), 0700)
			case "other-directory":
				err = os.Mkdir(filepath.Join(dir, "extracted"), 0700)
			case "directory-link":
				err = os.Symlink(t.TempDir(), filepath.Join(dir, "unit"))
			case "file-link":
				sparseFile(t, filepath.Join(dir, "source.pdf"), 1)
				err = os.Symlink("source.pdf", filepath.Join(dir, "output"))
			case "cycle-link":
				err = os.Symlink(".", filepath.Join(dir, "unit"))
			}
			if err != nil {
				t.Fatal(err)
			}
			mustCode(t, taskForTest(t, dir).check(context.Background()), CodeResourceLimit)
		})
	}
}

// 稀疏文件模拟多个 64 MiB 输出，避免测试本身实际写入数百 MiB。
const writeManyLargeFiles = `for n in 1 2 3 4 5; do /bin/dd if=/dev/zero of="large-$n" bs=1 count=0 seek=67108864 2>/dev/null || exit 9; done`
const writeManyEntries = `n=0; while [ "$n" -lt 512 ]; do : > "part-$n"; n=$((n+1)); done`

func TestPrepareTaskDirectoryLimitsAndCleanup(t *testing.T) {
	for _, test := range []struct{ name, body string }{
		{"many-small-success", writeManyEntries},
		{"many-large-success", writeManyLargeFiles},
		{"many-large-running", writeManyLargeFiles + "\n/bin/sleep 30"},
		{"forbidden-subdirectory", "/bin/mkdir -p extracted/nested"},
		{"symlink", "/bin/ln -s . unit"},
		{"fifo", "/usr/bin/mkfifo output"},
	} {
		t.Run(test.name, func(t *testing.T) {
			path, _ := fakeBinary(t, test.body+"\nprintf '%s' '{\"ok\":true,\"markdown\":\"hello\",\"engine\":\"anydoc\"}'")
			dir := t.TempDir()
			err := Prepare(context.Background(), Config{Command: path, Timeout: 5 * time.Second}, "a.docx", []byte("x"), dir, nil, noEmit(t))
			// 必须由资源监控终止，不能等到总超时后只得到 DeadlineExceeded。
			// 不限制进程启动为 1 秒，避免竞态检测及高负载环境造成误报。
			mustCode(t, err, CodeResourceLimit)
			mustClean(t, dir)
		})
	}
}

func TestExecTaskLimitsKillProcessGroup(t *testing.T) {
	path, dir := fakeBinary(t, "( /bin/sleep 0.3; printf escaped > escaped ) &\n"+writeManyLargeFiles+"\nwait")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err := (execRunner{}).run(ctx, path, dir, nil, 1024)
	mustCode(t, err, CodeResourceLimit)
	time.Sleep(400 * time.Millisecond)
	if _, err := os.Lstat(filepath.Join(dir, "escaped")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("超限后子进程仍在写入")
	}
}

func TestExecTaskPrecheckIncludesParentOfUnit(t *testing.T) {
	path, _ := fakeBinary(t, "printf started > started")
	dir := t.TempDir()
	unit := filepath.Join(dir, "unit")
	if err := os.Mkdir(unit, 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		sparseFile(t, filepath.Join(dir, fmt.Sprint(i)), 64<<20)
	}
	ctx := context.WithValue(context.Background(), taskDirectoryKey{}, dir)
	_, err := (execRunner{}).run(ctx, path, unit, nil, 1024)
	mustCode(t, err, CodeResourceLimit)
	mustClean(t, unit)
}

func TestExecTaskPostcheckIncludesParentOfUnit(t *testing.T) {
	path, _ := fakeBinary(t, "cd ..\n"+writeManyLargeFiles+"\nprintf 'success'")
	dir := t.TempDir()
	unit := filepath.Join(dir, "unit")
	if err := os.Mkdir(unit, 0700); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), taskDirectoryKey{}, dir)
	_, err := (execRunner{}).run(ctx, path, unit, nil, 1024)
	mustCode(t, err, CodeResourceLimit)
}

func TestCheckRuntimeOwnTemporaryDirectoryCleanup(t *testing.T) {
	var used string
	runner := runnerFunc(func(_ context.Context, _, dir string, _ []string, _ int) ([]byte, error) {
		if used != "" && used != dir {
			t.Fatal("版本探测必须共享有界临时目录")
		}
		used = dir
		if err := os.WriteFile(filepath.Join(dir, "scratch"), []byte("temporary"), 0600); err != nil {
			t.Fatal(err)
		}
		return []byte("version"), nil
	})
	if err := checkRuntime(context.Background(), Config{}, runner); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(used); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("版本探测未清理临时目录")
	}
}
