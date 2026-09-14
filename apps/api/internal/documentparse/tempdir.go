package documentparse

import (
	"context"
	"errors"
	"io"
	"os"
	"time"
)

const (
	maxTaskBytes   = 256 << 20
	maxTaskEntries = 64 // 包含原文件、unit 目录及其中的文件。
	taskScanPeriod = 20 * time.Millisecond
	taskScanBatch  = 8
)

type taskDirectoryKey struct{}

// 固定目录形状：Rust 使用 to_markdown_bytes / 内存工作簿；Poppler 每次仅输出
// 一页 PDF 或一张 PNG。因此只允许根目录及 unit，不遍历任意深度的解析器目录。
// 这是前后校验和定时监控，不是 OS 磁盘 quota；两次采样间仍可能短暂超额。
type taskDirectory struct{ root *os.Root }

func openTaskDirectory(path string) (*taskDirectory, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, failure(CodeIO)
	}
	if !before.IsDir() {
		return nil, failure(CodeResourceLimit)
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, failure(CodeIO)
	}
	after, err := root.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		root.Close()
		return nil, failure(CodeIO)
	}
	return &taskDirectory{root: root}, nil
}

func (d *taskDirectory) check(ctx context.Context) error {
	entries, remaining := maxTaskEntries, int64(maxTaskBytes)
	return checkTaskLevel(ctx, d.root, true, &entries, &remaining)
}

func checkTaskLevel(ctx context.Context, root *os.Root, allowUnit bool, entries *int, remaining *int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	dir, err := root.Open(".")
	if err != nil {
		return failure(CodeIO)
	}
	defer dir.Close()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// 不用 os.ReadDir/WalkDir：它们会先加载、排序整个不可信目录。
		// 即使对手持续创建条目，每次扫描最多处理 65 个，内存及深度固定。
		names, readErr := dir.Readdirnames(min(taskScanBatch, *entries+1))
		for _, name := range names {
			if err := ctx.Err(); err != nil {
				return err
			}
			*entries--
			if *entries < 0 {
				return failure(CodeResourceLimit)
			}
			info, err := root.Lstat(name)
			if errors.Is(err, os.ErrNotExist) {
				// 进程可以删除刚写完的临时文件；仍扣减本次扫描的条目预算。
				continue
			}
			if err != nil {
				return failure(CodeIO)
			}
			switch {
			case info.Mode().IsRegular():
				if info.Size() < 0 || info.Size() > *remaining {
					return failure(CodeResourceLimit)
				}
				*remaining -= info.Size()
			case info.IsDir() && allowUnit && name == "unit":
				unit, err := root.OpenRoot(name)
				if err != nil {
					return failure(CodeIO)
				}
				after, statErr := unit.Stat(".")
				if statErr != nil || !os.SameFile(info, after) {
					unit.Close()
					return failure(CodeResourceLimit)
				}
				err = checkTaskLevel(ctx, unit, false, entries, remaining)
				unit.Close()
				if err != nil {
					return err
				}
			default:
				// 拒绝符号链接（包括目录链接）、设备、FIFO 和其他子目录。
				return failure(CodeResourceLimit)
			}
		}
		if errors.Is(readErr, io.EOF) {
			return ctx.Err()
		}
		if readErr != nil {
			return failure(CodeIO)
		}
	}
}

func (d *taskDirectory) watch(ctx context.Context, cancel context.CancelFunc) error {
	ticker := time.NewTicker(taskScanPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := d.check(ctx); err != nil {
				if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
					return nil
				}
				cancel() // CommandContext 的 Cancel 会杀掉整个进程组。
				return err
			}
		}
	}
}
