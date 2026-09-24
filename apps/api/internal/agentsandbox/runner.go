// Package agentsandbox 在独立 Docker 容器中运行代码；从不挂载宿主文件或凭据。
package agentsandbox

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type Request struct {
	Language string `json:"language"`
	Code     string `json:"code"`
}
type Result struct {
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	ExitCode  int    `json:"exitCode"`
	Truncated bool   `json:"truncated"`
}
type Runner struct {
	Command string
	Image   string
	Timeout time.Duration
	slots   chan struct{}
}

func NewRunner(command, image string, timeout time.Duration) *Runner {
	return &Runner{Command: command, Image: image, Timeout: timeout, slots: make(chan struct{}, 2)}
}

func dockerArgs(name, image, language string) ([]string, error) {
	args := []string{"run", "--rm", "--pull=never", "--name", name, "--network=none", "--read-only", "--cap-drop=ALL",
		"--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--memory-swap=256m", "--cpus=1", "--ulimit", "nofile=128:128",
		"--user=65534:65534", "--workdir=/tmp", "--tmpfs=/tmp:rw,noexec,nosuid,size=64m", "--env=HOME=/tmp", "-i", image}
	switch language {
	case "python":
		args = append(args, "python3", "-I", "-")
	case "javascript":
		args = append(args, "node", "--max-old-space-size=128", "-")
	default:
		return nil, errors.New("仅支持 python/javascript")
	}
	return args, nil
}

func (r *Runner) Run(ctx context.Context, request Request) (*Result, error) {
	if len(request.Code) == 0 || len(request.Code) > 64*1024 {
		return nil, errors.New("代码须为 1–65536 字节")
	}
	name := "petrichor-sandbox-" + uuid.NewString()
	args, err := dockerArgs(name, r.Image, request.Language)
	if err != nil {
		return nil, err
	}
	select {
	case r.slots <- struct{}{}:
		defer func() { <-r.slots }()
	default:
		return nil, errors.New("沙箱繁忙")
	}
	ctx, cancel := context.WithTimeout(ctx, r.Timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.Command, args...)
	cmd.WaitDelay = time.Second
	cmd.Stdin = strings.NewReader(request.Code)
	stdout, stderr := &cappedBuffer{}, &cappedBuffer{}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	// docker run 的客户端退出不保证容器退出，所有路径都显式清理命名容器。
	defer func() {
		cleanup, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancelCleanup()
		_ = exec.CommandContext(cleanup, r.Command, "rm", "-f", name).Run()
	}()
	err = cmd.Run()
	if ctx.Err() != nil {
		return nil, errors.New("代码执行超时或已取消")
	}
	exitCode := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return nil, errors.New("无法启动代码沙箱")
		}
		exitCode = exit.ExitCode()
		if exitCode >= 125 {
			return nil, fmt.Errorf("代码沙箱不可用（退出码 %d）", exitCode)
		}
	}
	return &Result{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: exitCode, Truncated: stdout.truncated || stderr.truncated}, nil
}

type cappedBuffer struct {
	mu sync.Mutex
	bytes.Buffer
	truncated bool
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(p)
	remaining := 128*1024 - b.Len()
	if n > remaining {
		b.truncated = true
		p = p[:remaining]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}
