package documentparse

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxStderrBytes = 64 << 10
	pipeWaitDelay  = 2 * time.Second
)

type execRunner struct{}

// CheckRuntime 仅检查已安装工具，绝不联网或自动安装；版本输出不会进入错误文本。
func CheckRuntime(ctx context.Context, cfg Config) error {
	return checkRuntime(ctx, cfg, execRunner{})
}

func checkRuntime(ctx context.Context, cfg Config, runner commandRunner) (result error) {
	cfg = cfg.normalized()
	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	// 版本探测也使用受监控的独立临时目录，不能扫描或让工具写入 Worker cwd。
	dir, err := os.MkdirTemp("", "documentparse-runtime-")
	if err != nil {
		return failure(CodeIO)
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil && result == nil {
			result = failure(CodeIO)
		}
	}()
	ctx = context.WithValue(ctx, taskDirectoryKey{}, dir)
	version, err := runner.run(ctx, cfg.Command, dir, []string{"--version"}, 4096)
	if err != nil {
		return err
	}
	if len(version) > 4096 || !utf8.Valid(version) || strings.TrimSpace(string(version)) == "" {
		return failure(CodeProtocol)
	}
	for _, tool := range []string{"pdfinfo", "pdfseparate", "pdftoppm"} {
		if _, err := runner.run(ctx, tool, dir, []string{"-v"}, maxToolOutput); err != nil {
			return err
		}
	}
	if runtime.GOOS == "linux" {
		if _, err := runner.run(ctx, "prlimit", dir, []string{"--version"}, 4096); err != nil {
			return err
		}
	}
	return ctx.Err()
}

func executable(name string) (string, error) {
	path := name
	if !filepath.IsAbs(path) {
		// 拒绝相对路径和 PATH 中的当前目录条目，不接受命令字符串。
		if path == "" || strings.ContainsAny(path, "/\\") {
			return "", failure(CodeRuntimeUnavailable)
		}
		var err error
		path, err = exec.LookPath(path)
		if err != nil || !filepath.IsAbs(path) {
			return "", failure(CodeRuntimeUnavailable)
		}
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0111 == 0) {
		return "", failure(CodeRuntimeUnavailable)
	}
	return path, nil
}

func resourceArgs(path string, args []string) []string {
	limits := []string{
		"--as=1073741824:1073741824", "--cpu=120:120",
		"--fsize=134217728:134217728", "--nofile=128:128", "--", path,
	}
	return append(limits, args...)
}

func (execRunner) run(ctx context.Context, command, dir string, args []string, outputLimit int) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	path, err := executable(command)
	if err != nil {
		return nil, err
	}
	// 生产仅 Linux 使用 prlimit；macOS 等开发环境可运行假二进制，不伪称已施加 RLIMIT。
	if runtime.GOOS == "linux" {
		limiter, err := executable("prlimit")
		if err != nil {
			return nil, err
		}
		args, path = resourceArgs(path, args), limiter
	}
	root, ok := ctx.Value(taskDirectoryKey{}).(string)
	if !ok {
		root = dir
	}
	task, err := openTaskDirectory(root)
	if err != nil {
		return nil, err
	}
	defer task.root.Close()
	if err := task.check(ctx); err != nil {
		return nil, err
	}
	childCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(childCtx, path, args...)
	cmd.Dir = dir
	// 不继承凭据、代理、动态链接注入或用户配置；临时文件位置指定为任务目录，非文件系统沙箱。
	cmd.Env = []string{"LC_ALL=C", "TMPDIR=" + dir, "TMP=" + dir, "TEMP=" + dir}
	cmd.WaitDelay = pipeWaitDelay
	configureProcess(cmd)
	stdout := &boundedOutput{max: outputLimit, cancel: cancel, keep: true}
	stderr := &boundedOutput{max: maxStderrBytes, cancel: cancel, keep: true}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	watchCtx, stopWatch := context.WithCancel(childCtx)
	watched := make(chan error, 1)
	go func() { watched <- task.watch(watchCtx, cancel) }()
	err = cmd.Run()
	// 即便父进程先退出，也清理同组后代，防止它们继续占用任务目录和管道。
	stopProcess(cmd)
	stopWatch()
	watchErr := <-watched
	if ctxErr := ctx.Err(); ctxErr != nil {
		return nil, ctxErr
	}
	if watchErr != nil {
		return nil, watchErr
	}
	// 短于采样周期的命令也不能带着大量小文件或超额总量成功返回。
	if err := task.check(ctx); err != nil {
		return nil, err
	}
	if stdout.exceeded || stderr.exceeded {
		return nil, failure(CodeResourceLimit)
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			if resourceExit(exit) {
				return nil, failure(CodeResourceLimit)
			}
			return nil, &Error{Code: CodeCommandFailed, exitCode: exit.ExitCode(), incorrectPassword: hasPasswordDiagnostic(stderr.buf.Bytes())}
		}
		if errors.Is(err, exec.ErrWaitDelay) {
			return nil, failure(CodeCommandFailed)
		}
		var pathErr *os.PathError
		if errors.As(err, &pathErr) {
			return nil, failure(CodeRuntimeUnavailable)
		}
		return nil, failure(CodeIO)
	}
	return stdout.buf.Bytes(), nil
}

// 只识别 LC_ALL=C 的完整固定诊断行，绝不保留原始 stderr 到错误或日志中。
func hasPasswordDiagnostic(data []byte) bool {
	for line := range bytes.Lines(data) {
		if bytes.Equal(bytes.TrimSuffix(bytes.TrimSuffix(line, []byte("\n")), []byte("\r")), []byte("Command Line Error: Incorrect password")) {
			return true
		}
	}
	return false
}

// 两条管道各自有一个写协程；Run 返回后才读取状态，不共享可变缓冲区。
// stderr 最多暂存 64 KiB，仅用于固定分类，超量停止子进程且不返回部分输出。
type boundedOutput struct {
	buf      bytes.Buffer
	max      int
	written  int
	exceeded bool
	keep     bool
	cancel   context.CancelFunc
}

func (w *boundedOutput) Write(data []byte) (int, error) {
	n := len(data)
	remaining := w.max - w.written
	if remaining < len(data) {
		data = data[:remaining]
		w.exceeded = true
		w.cancel()
	}
	w.written += len(data)
	if w.keep {
		_, _ = w.buf.Write(data)
	}
	return n, nil
}
