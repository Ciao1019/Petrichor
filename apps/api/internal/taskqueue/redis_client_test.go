package taskqueue

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestQueueRedisDeadlineBoundsStartedIO(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		accepted <- conn
		// 接收命令但不回应，模拟 Redis 连接未断开的网络黑洞。
		_, _ = io.Copy(io.Discard, conn)
	}()
	client := newQueueRedisClient(&redis.Options{
		Addr: listener.Addr().String(), DialTimeout: time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second,
		MaxRetries: -1,
	})
	defer client.Close()
	if !client.Options().ContextTimeoutEnabled {
		t.Fatal("生产 Redis 客户端未启用 context deadline")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	err = client.Ping(ctx).Err()
	if err == nil || time.Since(start) >= 3*time.Second {
		t.Fatalf("请求被 30 秒网络超时拖住: elapsed=%s err=%v", time.Since(start), err)
	}
	select {
	case conn := <-accepted:
		_ = conn.Close()
	default:
		t.Fatal("没有覆盖已开始的网络 I/O")
	}
	_ = listener.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("测试连接未清理")
	}
}
