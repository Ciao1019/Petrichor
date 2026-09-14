//go:build linux || darwin || freebsd || openbsd || netbsd || dragonfly

package documentparse

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// 不跟随最终符号链接，且在路径被替换为 FIFO 时也不会阻塞。
func openReadOnly(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}

func configureProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return stopProcess(cmd) }
}

func stopProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return os.ErrProcessDone
	}
	err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}

func resourceExit(exit *exec.ExitError) bool {
	status, ok := exit.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return false
	}
	// Rust 分配失败通常 abort；内核 OOM、CPU 和文件大小上限均为永久资源错误。
	switch status.Signal() {
	case syscall.SIGKILL, syscall.SIGABRT, syscall.SIGXCPU, syscall.SIGXFSZ, syscall.SIGSEGV:
		return true
	default:
		return false
	}
}
