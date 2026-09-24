package agentsandbox

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestDockerIsolationArguments(t *testing.T) {
	args, err := dockerArgs("test", "image", "python")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Join(args, " ")
	for _, required := range []string{"--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=65534:65534", "--memory=256m", "--pids-limit=64", "--pull=never"} {
		if !strings.Contains(text, required) {
			t.Fatalf("缺少 %s", required)
		}
	}
	if _, err := dockerArgs("test", "image", "sh"); err == nil {
		t.Fatal("允许任意命令")
	}
}

func TestSandboxDockerIntegration(t *testing.T) {
	if os.Getenv("PETRICHOR_SANDBOX_TEST") != "1" {
		t.Skip("需要专用测试镜像")
	}
	runner := NewRunner("docker", "petrichor-sandbox:local", 3*time.Second)
	out, err := runner.Run(context.Background(), Request{Language: "python", Code: "import os, socket\nprint(os.getuid())\ntry:\n open('/host-leak','w')\nexcept OSError:\n print('readonly')\ntry:\n socket.create_connection(('1.1.1.1',80),0.3)\nexcept OSError:\n print('offline')"})
	if err != nil || !strings.Contains(out.Stdout, "65534\nreadonly\noffline") {
		t.Fatalf("%+v %v", out, err)
	}
	out, err = runner.Run(context.Background(), Request{Language: "javascript", Code: "console.log([1,2,3].reduce((a,b)=>a+b,0))"})
	if err != nil || strings.TrimSpace(out.Stdout) != "6" {
		t.Fatalf("%+v %v", out, err)
	}
	if _, err = runner.Run(context.Background(), Request{Language: "python", Code: "while True: pass"}); err == nil {
		t.Fatal("未限制运行时间")
	}
}
