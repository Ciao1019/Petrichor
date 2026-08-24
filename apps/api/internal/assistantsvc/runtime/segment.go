package runtime

import (
	"context"
	"encoding/json"
	"strings"

	aicore "petrichor/api/internal/aicore"
)

// ===== 段级推理：工具调用循环（对照 mastra-bridge.ts）=====
//
// 底层 Tool Calling Loop 基于 aicore.ChatWithTools；
// 每个 Agent 工具都被包成"转发到 ToolExecutor"的调用，不存在绕过执行器的路径。

// SegmentStopSignal 由 StopPolicy / SkillLoader 触发，要求提前结束本段推理。
type SegmentStopSignal struct {
	Reason string
}

// SegmentRequest 一段推理的入参。
type SegmentRequest struct {
	AgentID      string
	Model        *ResolvedModelHandle
	Instructions string
	Messages     []map[string]any // 已由 Context Manager 裁剪的模型消息；为空时用 Prompt
	Prompt       string
	Tools        []*AgentToolDefinition
	Ctx          *ToolExecutionContext
	Executor     *ToolExecutor
	MaxSteps     int
	Temperature  *float64

	OnTextDelta   func(delta string)
	OnAnswerReset func()
	OnToolOutcome func(outcome *ToolRunOutcome)

	ContextTokenLimit int64
}

// ResolvedModelHandle 已解析的模型（Runtime 层注入，避免依赖 aicore 内部结构）。
type ResolvedModelHandle struct {
	Runtime aicore.RuntimeConfig
	ModelID string
	Options aicore.GenerationOptions
}

// SegmentResult 一段推理的结果。
type SegmentResult struct {
	Text          string
	ToolCallCount int
	Usage         AgentTokenUsage
	Stopped       *SegmentStopSignal
	Aborted       bool
	LlmMs         int64
}

// SegmentController 段级中止控制：load_skill 或 StopPolicy 触发时提前收束本段。
type SegmentController struct {
	stoppedCh  chan struct{}
	stopSignal *SegmentStopSignal
}

// NewSegmentController 构造。
func NewSegmentController() *SegmentController {
	return &SegmentController{stoppedCh: make(chan struct{})}
}

// Request 请求结束当前段并立即中止。
//
// 必须同步中止：否则下一轮会带着旧的 activeTools 再发模型请求，
// 刚加载的技能工具在那一轮里仍然不可见。工具结果、观察与证据都已写入 Store，
// 下一段由 ContextManager 重新组装上下文。
func (c *SegmentController) Request(reason string) {
	if c.stopSignal != nil {
		return
	}
	c.stopSignal = &SegmentStopSignal{Reason: reason}
	select {
	case <-c.stoppedCh:
	default:
		close(c.stoppedCh)
	}
}

// Stopped 当前停止信号。
func (c *SegmentController) Stopped() *SegmentStopSignal { return c.stopSignal }

// Done 返回停止通知 channel。
func (c *SegmentController) Done() <-chan struct{} { return c.stoppedCh }

const (
	modelEvidenceMaxItems     = 12
	modelEvidenceMaxChars     = 6000
	modelEvidenceItemMaxChars = 1200
	modelFullReadItemMaxChars = 20000
	modelFullReadMaxChars     = 40000
)

// ToModelResult 回给模型的紧凑结果：只给摘要 + 结构化要点，不回灌原始大对象。
func ToModelResult(outcome *ToolRunOutcome) string {
	if !outcome.OK {
		payload := map[string]any{
			"ok":               false,
			"errorCode":        "",
			"message":          "",
			"suggestedActions": []string{},
		}
		if outcome.Error != nil {
			payload["errorCode"] = outcome.Error.Code
			payload["message"] = outcome.Error.Message
			if len(outcome.Observation.SuggestedActions) > 0 {
				payload["suggestedActions"] = outcome.Observation.SuggestedActions
			}
		}
		return string(mustJSON(payload))
	}

	payload := map[string]any{
		"ok":      true,
		"summary": outcome.Observation.Summary,
	}
	if len(outcome.Observation.Data) > 0 && string(outcome.Observation.Data) != "null" {
		payload["data"] = json.RawMessage(outcome.Observation.Data)
	}
	if len(outcome.Evidence) > 0 {
		payload["evidence"] = evidenceForModel(outcome)
	}
	if len(outcome.Observation.SuggestedActions) > 0 {
		payload["suggestedActions"] = outcome.Observation.SuggestedActions
	}
	return string(mustJSON(payload))
}

// evidenceForModel 给段内下一次 LLM 的是精选 Evidence；分片段/全文两套预算。
func evidenceForModel(outcome *ToolRunOutcome) []map[string]any {
	snippetRemaining := modelEvidenceMaxChars
	fullReadRemaining := modelFullReadMaxChars
	out := make([]map[string]any, 0, len(outcome.Evidence))
	for index, item := range outcome.Evidence {
		if index >= modelEvidenceMaxItems {
			break
		}
		contentLen := len([]rune(item.Content))
		take := 0
		if item.FullRead {
			take = minInt(contentLen, modelFullReadItemMaxChars, fullReadRemaining)
			fullReadRemaining -= take
		} else {
			take = minInt(contentLen, modelEvidenceItemMaxChars, snippetRemaining)
			snippetRemaining -= take
		}
		content := ""
		if take > 0 {
			content = withTruncationNotice(item.Content, take)
		}
		entry := map[string]any{
			"ref":    index + 1,
			"id":     item.ID,
			"source": string(item.Source),
			"title":  item.Title,
		}
		if idx := outcome.EvidenceCitationIndices; len(idx) > index {
			entry["ref"] = idx[index]
		} else if entry["ref"].(int) < 1 {
			entry["ref"] = index + 1
		}
		if content != "" {
			entry["content"] = content
		}
		if item.URL != "" {
			entry["url"] = item.URL
		}
		if path, ok := item.Metadata["path"].([]any); ok && len(path) > 0 {
			entry["path"] = path
		}
		out = append(out, entry)
	}
	return out
}

// withTruncationNotice 截断必须显式告知：静默截断会被当成内容缺失。
func withTruncationNotice(content string, take int) string {
	total := len([]rune(content))
	if take >= total {
		return content
	}
	r := []rune(content)
	return string(r[:take]) + "\n\n[正文过长，本次仅给出前 " + itoa(take) + " 字，共 " + itoa(total) + " 字]"
}

// RunAgentSegment 执行一段推理：一次段内可含多轮工具调用。
func RunAgentSegment(ctx context.Context, request *SegmentRequest, controller *SegmentController) *SegmentResult {
	startedAt := nowMs()
	var text strings.Builder
	var lastAnswer strings.Builder
	toolCallCount := 0

	// 组装消息序列：system + 历史 + 本轮目标
	msgs := make([]aicore.ChatMessage, 0, len(request.Messages)+2)
	msgs = append(msgs, aicore.ChatMessage{Role: "system", Content: request.Instructions})
	for _, m := range request.Messages {
		role, _ := m["role"].(string)
		content, _ := m["content"].(string)
		if role == "" && content == "" {
			continue
		}
		msgs = append(msgs, aicore.ChatMessage{Role: role, Content: content})
	}
	if len(request.Messages) == 0 && request.Prompt != "" {
		msgs = append(msgs, aicore.ChatMessage{Role: "user", Content: request.Prompt})
	}

	toolsPayload := make([]aicore.ToolDefinition, 0, len(request.Tools))
	for _, t := range request.Tools {
		schema := t.InputSchema
		if len(schema) == 0 {
			schema = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		toolsPayload = append(toolsPayload, aicore.ToolDefinition{Name: t.Name, Description: t.Description, Parameters: schema})
	}

	usage := AgentTokenUsage{}
	onDelta := func(delta string) error {
		text.WriteString(delta)
		lastAnswer.WriteString(delta)
		if request.OnTextDelta != nil {
			request.OnTextDelta(delta)
		}
		return nil
	}

	maxSteps := request.MaxSteps
	if maxSteps < 1 {
		maxSteps = 1
	}

	for step := 0; step < maxSteps; step++ {
		if ctx.Err() != nil || controller.Stopped() != nil {
			break
		}

		result, err := aicore.ChatWithTools(ctx, request.Model.Runtime, request.Model.ModelID, msgs, request.Model.Options, toolsPayload, onDelta)
		if result != nil {
			usage.Input += result.InputTokens
			usage.Output += result.OutputTokens
			usage.Total += result.InputTokens + result.OutputTokens
		}
		if err != nil {
			if ctx.Err() != nil || controller.Stopped() != nil {
				break
			}
			// 模型调用失败按错误返回给上层 Runtime 处理
			return &SegmentResult{
				Text: text.String(), ToolCallCount: toolCallCount,
				Stopped: controller.Stopped(), Aborted: ctx.Err() != nil,
				LlmMs: nowMs() - startedAt,
			}
		}

		if len(result.ToolCalls) == 0 {
			break
		}

		// 有工具调用 → 之前的文本是过程话，不是答案
		if text.Len() > 0 {
			text.Reset()
			if request.OnAnswerReset != nil {
				request.OnAnswerReset()
			}
		}

		// 记录 assistant 发起的调用
		assistantMsg := aicore.ChatMessage{Role: "assistant", Content: result.Answer, ToolCalls: result.ToolCalls}
		msgs = append(msgs, assistantMsg)
		for _, call := range result.ToolCalls {
			toolCallCount++
			_ = toolCallCount
			var input any
			if strings.TrimSpace(call.ArgsJSON) != "" {
				_ = json.Unmarshal([]byte(call.ArgsJSON), &input)
			}
			outcome := request.Executor.Execute(ctx, call.Name, input, request.Ctx)
			if request.OnToolOutcome != nil {
				request.OnToolOutcome(&outcome)
			}
			msgs = append(msgs, aicore.ChatMessage{
				Role:       "tool",
				Content:    ToModelResult(&outcome),
				ToolCallID: call.ID,
			})
		}
	}

	return &SegmentResult{
		Text:          text.String(),
		ToolCallCount: toolCallCount,
		Usage:         usage,
		Stopped:       controller.Stopped(),
		Aborted:       ctx.Err() != nil,
		LlmMs:         nowMs() - startedAt,
	}
}

func minInt(a, b, c int) int {
	out := a
	if b < out {
		out = b
	}
	if c < out {
		out = c
	}
	return out
}
