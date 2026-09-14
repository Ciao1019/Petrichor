//go:build !linux && !darwin && !freebsd && !openbsd && !netbsd && !dragonfly

package documentparse

import (
	"os"
	"os/exec"
)

func openReadOnly(path string) (*os.File, error) { return os.Open(path) }

// 非 Unix 平台只提供开发用的单进程取消；生产资源隔离要求 Linux。
func configureProcess(cmd *exec.Cmd) {}

func stopProcess(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return os.ErrProcessDone
	}
	return cmd.Process.Kill()
}

func resourceExit(exit *exec.ExitError) bool { return false }
