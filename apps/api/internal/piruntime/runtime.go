// Package piruntime 通过私有 stdio 管道运行 Pi Agent Core。
// Pi 管理模型与工具循环；凭据、权限和业务副作用全部留在 Go 宿主。
package piruntime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"petrichor/api/internal/config"
)

var ErrTurnLimit = errors.New("Pi 已达到模型轮次上限")

type ToolCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"toolCalls,omitempty"`
	ToolCallID string     `json:"toolCallId,omitempty"`
	ToolName   string     `json:"toolName,omitempty"`
}

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

type ModelResult struct {
	Text         string     `json:"text"`
	ToolCalls    []ToolCall `json:"toolCalls,omitempty"`
	InputTokens  int64      `json:"inputTokens"`
	OutputTokens int64      `json:"outputTokens"`
}

type ToolResult struct {
	Text    string
	IsError bool
}

type Request struct {
	Controls      func(context.Context) ([]Control, error)
	Messages      []Message
	Tools         []Tool
	MaxTurns      int
	ContextTokens int
	Model         func(context.Context, []Message, func(string) error) (*ModelResult, error)
	Execute       func(context.Context, ToolCall) (ToolResult, error)
	Compact       func(context.Context, []Message) (string, error)
}

type Result struct {
	Text         string
	InputTokens  int64
	OutputTokens int64
}

type frame struct {
	Type         string    `json:"type"`
	ID           string    `json:"id"`
	Messages     []Message `json:"messages"`
	Call         ToolCall  `json:"call"`
	Failed       bool      `json:"failed"`
	LimitReached bool      `json:"limitReached"`
}

// Run 每次创建独立 Pi 进程，避免不同用户、知识库或子任务共享可变会话。
// 所有返回路径均终止并回收子进程；context 同时取消模型请求和工具执行。
func Run(ctx context.Context, request Request) (*Result, error) {
	result := &Result{}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if request.Model == nil || len(request.Messages) == 0 {
		return result, errors.New("缺少 Pi 模型或消息")
	}
	if request.MaxTurns < 1 {
		request.MaxTurns = 1
	}
	if request.Tools == nil {
		request.Tools = []Tool{}
	}
	if request.Compact == nil {
		request.ContextTokens = 0
	}
	command, args, err := resolveCommand()
	if err != nil {
		return result, err
	}
	processCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(processCtx, command, args...)
	cmd.WaitDelay = 3 * time.Second
	// 不把调用方的环境凭据交给 Pi；当前桥接不加载插件、文件工具或模型供应商。
	cmd.Env = []string{}
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return result, fmt.Errorf("创建 Pi 输入管道失败: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return result, fmt.Errorf("创建 Pi 输出管道失败: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return result, fmt.Errorf("启动 Pi 失败，请安装 Agent 依赖: %w", err)
	}
	defer func() { _ = stdin.Close(); cancel(); _ = cmd.Wait() }()
	encoder := json.NewEncoder(stdin)
	if err := encoder.Encode(map[string]any{
		"type": "start", "version": 1, "messages": request.Messages, "tools": request.Tools,
		"maxTurns": request.MaxTurns, "contextTokens": request.ContextTokens,
		"enableControl": request.Controls != nil,
	}); err != nil {
		return result, fmt.Errorf("初始化 Pi 失败: %w", err)
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 32*1024*1024)
	modelTurns := 0
	allowed := map[string]bool{}
	for _, tool := range request.Tools {
		allowed[tool.Name] = true
	}
	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		var incoming frame
		if json.Unmarshal(scanner.Bytes(), &incoming) != nil {
			return result, errors.New("Pi 返回了无效的协议帧")
		}
		reply := map[string]any{"type": "result", "id": incoming.ID}
		switch incoming.Type {
		case "control":
			controls := []Control{}
			if request.Controls != nil {
				var err error
				controls, err = request.Controls(ctx)
				if err != nil {
					return result, err
				}
			}
			reply["controls"] = controls
		case "model":
			modelTurns++
			if modelTurns > request.MaxTurns {
				return result, ErrTurnLimit
			}
			model, err := request.Model(ctx, incoming.Messages, func(delta string) error {
				return encoder.Encode(map[string]any{"type": "delta", "id": incoming.ID, "delta": delta})
			})
			if err != nil {
				return result, err
			}
			if model == nil {
				return result, errors.New("Pi 模型返回为空")
			}
			result.Text = model.Text
			result.InputTokens += model.InputTokens
			result.OutputTokens += model.OutputTokens
			reply["model"] = model
		case "tool":
			if request.Execute == nil || !allowed[incoming.Call.Name] {
				return result, errors.New("Pi 请求了未授权的工具")
			}
			output, err := request.Execute(ctx, incoming.Call)
			if err != nil {
				return result, err
			}
			reply["text"], reply["isError"] = output.Text, output.IsError
		case "compact":
			if request.Compact == nil {
				return result, errors.New("Pi 请求了未配置的上下文压缩")
			}
			text, err := request.Compact(ctx, incoming.Messages)
			if err != nil {
				return result, err
			}
			reply["text"] = text
		case "done":
			if incoming.Failed {
				return result, errors.New("Pi Agent 执行失败")
			}
			if incoming.LimitReached {
				return result, ErrTurnLimit
			}
			return result, nil
		default:
			return result, errors.New("Pi 返回了未知的协议事件")
		}
		if err := encoder.Encode(reply); err != nil {
			return result, fmt.Errorf("写入 Pi 响应失败: %w", err)
		}
	}
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	if scanner.Err() != nil {
		return result, fmt.Errorf("读取 Pi 响应失败: %w", scanner.Err())
	}
	return result, errors.New("Pi 进程在完成前退出，请检查 Agent 依赖和入口路径")
}

func resolveCommand() (string, []string, error) {
	settings := config.Get().Agent.Pi
	command := settings.Command
	if command == "" {
		command = "bun"
	}
	if settings.Entry != "" {
		return command, []string{settings.Entry}, nil
	}
	// 镜像把已打包入口放在 Go 可执行文件旁。
	if executable, err := os.Executable(); err == nil {
		entry := filepath.Join(filepath.Dir(executable), "pi-agent", "index.js")
		if info, err := os.Stat(entry); err == nil && !info.IsDir() {
			return command, []string{entry}, nil
		}
	}
	directory, err := os.Getwd()
	if err != nil {
		return "", nil, err
	}
	for {
		for _, relative := range []string{"tools/pi-agent/src/index.ts", "apps/api/tools/pi-agent/src/index.ts"} {
			entry := filepath.Join(directory, relative)
			if info, err := os.Stat(entry); err == nil && !info.IsDir() {
				return command, []string{entry}, nil
			}
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	return "", nil, errors.New("未找到 Pi 入口，请配置 agent.pi.entry")
}
