// sandbox 是独立执行服务，部署在有 Docker 的专用主机上；不读取应用密钥配置。
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/pelletier/go-toml/v2"
	"petrichor/api/internal/agentsandbox"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	path := flag.String("config", "sandbox.toml", "独立沙箱配置文件")
	flag.Parse()
	data, err := os.ReadFile(*path)
	if err != nil {
		return err
	}
	cfg := struct {
		Listen         string `toml:"listen"`
		Token          string `toml:"token"`
		Command        string `toml:"command"`
		Image          string `toml:"image"`
		TimeoutSeconds int    `toml:"timeout_seconds"`
	}{Listen: "127.0.0.1:8099", Command: "docker", Image: "petrichor-sandbox:local", TimeoutSeconds: 20}
	decoder := toml.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&cfg); err != nil {
		return fmt.Errorf("沙箱配置格式错误")
	}
	if len(cfg.Token) < 32 || cfg.TimeoutSeconds < 1 || cfg.TimeoutSeconds > 60 {
		return fmt.Errorf("沙箱须配置至少 32 字符 token，执行时限 1–60 秒")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	server := &http.Server{Addr: cfg.Listen, Handler: agentsandbox.Handler(agentsandbox.NewRunner(cfg.Command, cfg.Image, time.Duration(cfg.TimeoutSeconds)*time.Second), cfg.Token),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: time.Duration(cfg.TimeoutSeconds+10) * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, done := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer done()
		_ = server.Shutdown(shutdown)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
