package piruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func testTool() Tool {
	return Tool{Name: "lookup", Description: "查找", Parameters: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}`)}
}

func TestPiExecutesToolsAndPreservesHistory(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	calls, tools := 0, 0
	unicode := "正文\n中文\u2028分隔\u2029结尾"
	result, err := Run(ctx, Request{
		Messages: []Message{{Role: "system", Content: "指令"}, {Role: "user", Content: unicode}}, Tools: []Tool{testTool()}, MaxTurns: 3,
		Model: func(_ context.Context, messages []Message, delta func(string) error) (*ModelResult, error) {
			calls++
			if messages[1].Content != unicode {
				t.Fatal("Unicode 或换行损坏")
			}
			if calls == 1 {
				return &ModelResult{ToolCalls: []ToolCall{{ID: "call-1", Name: "lookup", Arguments: `{"q":"中文"}`}}, InputTokens: 5}, nil
			}
			last := messages[len(messages)-1]
			if last.Role != "tool" || last.ToolCallID != "call-1" || last.Content != unicode {
				t.Fatalf("工具结果丢失: %+v", last)
			}
			if err := delta("答"); err != nil {
				return nil, err
			}
			if err := delta("案"); err != nil {
				return nil, err
			}
			return &ModelResult{Text: "答案", InputTokens: 9, OutputTokens: 2}, nil
		},
		Execute: func(_ context.Context, call ToolCall) (ToolResult, error) {
			tools++
			if call.Arguments != `{"q":"中文"}` {
				t.Fatalf("参数被修改: %+v", call)
			}
			return ToolResult{Text: unicode}, nil
		},
	})
	if err != nil || result.Text != "答案" || calls != 2 || tools != 1 || result.InputTokens != 14 {
		t.Fatalf("result=%+v calls=%d tools=%d err=%v", result, calls, tools, err)
	}
}

func TestPiRejectsBadArgumentsWithoutExecuting(t *testing.T) {
	for _, args := range []string{`{"missing":true}`, `{`, `[]`} {
		t.Run(args, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			executed := false
			_, err := Run(ctx, Request{
				Messages: []Message{{Role: "user", Content: "test"}}, Tools: []Tool{testTool()}, MaxTurns: 1,
				Model: func(context.Context, []Message, func(string) error) (*ModelResult, error) {
					return &ModelResult{ToolCalls: []ToolCall{{ID: "bad", Name: "lookup", Arguments: args}}}, nil
				},
				Execute: func(context.Context, ToolCall) (ToolResult, error) { executed = true; return ToolResult{}, nil },
			})
			if executed || err == nil {
				t.Fatalf("非法参数被执行=%v err=%v", executed, err)
			}
		})
	}
}

func TestPiCancellationReachesModelAndTool(t *testing.T) {
	for _, phase := range []string{"model", "tool"} {
		t.Run(phase, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			started := make(chan struct{})
			go func() { <-started; cancel() }()
			_, err := Run(ctx, Request{
				Messages: []Message{{Role: "user", Content: "等待取消"}}, Tools: []Tool{testTool()}, MaxTurns: 2,
				Model: func(ctx context.Context, _ []Message, _ func(string) error) (*ModelResult, error) {
					if phase == "model" {
						close(started)
						<-ctx.Done()
						return nil, ctx.Err()
					}
					return &ModelResult{ToolCalls: []ToolCall{{ID: "wait", Name: "lookup", Arguments: `{"q":"x"}`}}}, nil
				},
				Execute: func(ctx context.Context, _ ToolCall) (ToolResult, error) {
					close(started)
					<-ctx.Done()
					return ToolResult{}, ctx.Err()
				},
			})
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("取消未传播: %v", err)
			}
		})
	}
}

func TestPiTurnLimitStopsUnboundedLoop(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	calls := 0
	_, err := Run(ctx, Request{
		Messages: []Message{{Role: "user", Content: "循环"}}, Tools: []Tool{testTool()}, MaxTurns: 2,
		Model: func(context.Context, []Message, func(string) error) (*ModelResult, error) {
			calls++
			return &ModelResult{ToolCalls: []ToolCall{{ID: "loop", Name: "lookup", Arguments: `{"q":"x"}`}}}, nil
		},
		Execute: func(context.Context, ToolCall) (ToolResult, error) { return ToolResult{Text: "结果"}, nil },
	})
	if !errors.Is(err, ErrTurnLimit) || calls != 2 {
		t.Fatalf("循环未收敛 calls=%d err=%v", calls, err)
	}
}

func TestPiCompactionReplacesContextAndKeepsTools(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	compactions, models := 0, 0
	_, err := Run(ctx, Request{
		Messages: []Message{{Role: "system", Content: "系统"}, {Role: "user", Content: strings.Repeat("长文档", 1000)}},
		Tools:    []Tool{testTool()}, MaxTurns: 3, ContextTokens: 2000,
		Compact: func(_ context.Context, messages []Message) (string, error) {
			compactions++
			if len(messages[1].Content) < 2000 {
				t.Fatal("压缩缺少原始上下文")
			}
			return "摘要保留原始目标", nil
		},
		Model: func(_ context.Context, messages []Message, _ func(string) error) (*ModelResult, error) {
			models++
			var summary string
			for _, message := range messages {
				if message.Role == "user" {
					summary = message.Content
					break
				}
			}
			if messages[0].Content != "系统" || summary != "摘要保留原始目标" {
				t.Fatalf("压缩后上下文错误: %+v", messages)
			}
			if models == 1 {
				return &ModelResult{ToolCalls: []ToolCall{{ID: "after-compact", Name: "lookup", Arguments: `{"q":"x"}`}}}, nil
			}
			return &ModelResult{Text: "完成"}, nil
		},
		Execute: func(context.Context, ToolCall) (ToolResult, error) {
			return ToolResult{Text: "工具仍可调用"}, nil
		},
	})
	if err != nil || compactions != 1 || models != 2 {
		t.Fatalf("compactions=%d models=%d err=%v", compactions, models, err)
	}
}
