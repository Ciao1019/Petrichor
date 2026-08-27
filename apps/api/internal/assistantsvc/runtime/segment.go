package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/flow/agent/react"
	"github.com/cloudwego/eino/schema"
	jsonschema "github.com/eino-contrib/jsonschema"

	aicore "petrichor/api/internal/aicore"
)

// ===== 段级推理：Eino ReAct（对照 mastra-bridge.ts）=====
//
// 标准的 Model → Tools → Model 循环交给 Eino ReAct；Petrichor 仍负责
// State / Plan / Evidence / Permission / StopPolicy。每个 Eino 工具都只是一层适配，
// 执行体统一转发到 ToolExecutor，不存在绕过权限、预算、Trace 的路径。

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

var errSegmentStopped = errors.New("agent segment stopped")

// SegmentController 段级中止控制：load_skill 或 StopPolicy 触发时提前收束本段。
type SegmentController struct {
	mu         sync.RWMutex
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
	c.mu.Lock()
	defer c.mu.Unlock()
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
func (c *SegmentController) Stopped() *SegmentStopSignal {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.stopSignal == nil {
		return nil
	}
	copy := *c.stopSignal
	return &copy
}

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
		switch path := item.Metadata["path"].(type) {
		case []any:
			if len(path) > 0 {
				entry["path"] = path
			}
		case []string:
			if len(path) > 0 {
				entry["path"] = path
			}
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

// segmentTelemetry 汇总跨多轮模型调用的数据。Eino 的模型与工具节点在独立 goroutine
// 中运行，因此这里显式加锁；工具节点配置为顺序执行，以保持 Petrichor Store 的顺序语义。
type segmentTelemetry struct {
	mu            sync.Mutex
	answer        strings.Builder
	usage         AgentTokenUsage
	toolCallCount int
	onTextDelta   func(string)
	onAnswerReset func()
}

func (t *segmentTelemetry) addDelta(delta string) {
	if delta == "" {
		return
	}
	t.mu.Lock()
	t.answer.WriteString(delta)
	t.mu.Unlock()
	if t.onTextDelta != nil {
		t.onTextDelta(delta)
	}
}

// markToolCalls 表示当前模型轮次最终选择了工具；此前输出的文本只是过程旁白。
func (t *segmentTelemetry) markToolCalls() {
	t.mu.Lock()
	hadAnswer := t.answer.Len() > 0
	if hadAnswer {
		t.answer.Reset()
	}
	t.mu.Unlock()
	if hadAnswer && t.onAnswerReset != nil {
		t.onAnswerReset()
	}
}

func (t *segmentTelemetry) addUsage(input, output int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.usage.Input += input
	t.usage.Output += output
	t.usage.Total += input + output
}

func (t *segmentTelemetry) markToolExecuted() {
	t.mu.Lock()
	t.toolCallCount++
	t.mu.Unlock()
}

func (t *segmentTelemetry) snapshot() (string, AgentTokenUsage, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.answer.String(), t.usage, t.toolCallCount
}

// einoChatModel 把项目现有的多供应商 aicore 适配为 Eino ToolCallingChatModel。
// 这样模型配置、凭据解密、供应商 quirks 仍只有一个实现，ReAct 循环则交由 Eino。
type einoChatModel struct {
	handle    *ResolvedModelHandle
	tools     []*schema.ToolInfo
	telemetry *segmentTelemetry
}

var _ model.ToolCallingChatModel = (*einoChatModel)(nil)

func (m *einoChatModel) WithTools(tools []*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	copyModel := *m
	copyModel.tools = append([]*schema.ToolInfo(nil), tools...)
	return &copyModel, nil
}

func (m *einoChatModel) Generate(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.Message, error) {
	chatMessages, tools, generation := m.prepare(input, opts...)
	var (
		result *aicore.ChatResult
		err    error
	)
	if len(tools) > 0 {
		result, err = aicore.ChatWithToolsOnce(ctx, m.handle.Runtime, m.handle.ModelID, chatMessages, generation, tools)
	} else {
		result, err = aicore.Chat(ctx, m.handle.Runtime, m.handle.ModelID, chatMessages, generation)
	}
	if err != nil {
		return nil, err
	}
	m.telemetry.addUsage(result.InputTokens, result.OutputTokens)
	return toEinoMessage(result, true), nil
}

func (m *einoChatModel) Stream(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	chatMessages, tools, generation := m.prepare(input, opts...)
	reader, writer := schema.Pipe[*schema.Message](32)

	go func() {
		defer writer.Close()
		result, err := aicore.ChatWithTools(ctx, m.handle.Runtime, m.handle.ModelID, chatMessages, generation, tools, func(delta string) error {
			m.telemetry.addDelta(delta)
			if closed := writer.Send(&schema.Message{Role: schema.Assistant, Content: delta}, nil); closed {
				return context.Canceled
			}
			return nil
		})
		if err != nil {
			writer.Send(nil, err)
			return
		}

		m.telemetry.addUsage(result.InputTokens, result.OutputTokens)
		if len(result.ToolCalls) > 0 {
			m.telemetry.markToolCalls()
		}
		// 文本已经逐块发送，末帧只携带工具调用与 usage，避免 ConcatMessages 重复正文。
		writer.Send(toEinoMessage(result, false), nil)
	}()

	return reader, nil
}

func (m *einoChatModel) prepare(input []*schema.Message, opts ...model.Option) ([]aicore.ChatMessage, []aicore.ToolDefinition, aicore.GenerationOptions) {
	base := &model.Options{Tools: append([]*schema.ToolInfo(nil), m.tools...)}
	common := model.GetCommonOptions(base, opts...)
	generation := m.handle.Options
	if common.Temperature != nil {
		value := float64(*common.Temperature)
		generation.Temperature = &value
	}
	if common.MaxTokens != nil {
		value := int64(*common.MaxTokens)
		generation.MaxTokens = &value
	}
	return fromEinoMessages(input), fromEinoToolInfos(common.Tools), generation
}

func fromEinoMessages(messages []*schema.Message) []aicore.ChatMessage {
	out := make([]aicore.ChatMessage, 0, len(messages))
	for _, message := range messages {
		if message == nil {
			continue
		}
		converted := aicore.ChatMessage{
			Role:       string(message.Role),
			Content:    message.Content,
			ToolCallID: message.ToolCallID,
		}
		for _, call := range message.ToolCalls {
			converted.ToolCalls = append(converted.ToolCalls, aicore.ToolCall{
				ID: call.ID, Name: call.Function.Name, ArgsJSON: call.Function.Arguments,
			})
		}
		out = append(out, converted)
	}
	return out
}

func fromEinoToolInfos(infos []*schema.ToolInfo) []aicore.ToolDefinition {
	out := make([]aicore.ToolDefinition, 0, len(infos))
	for _, info := range infos {
		if info == nil {
			continue
		}
		parameters := json.RawMessage(`{"type":"object","properties":{}}`)
		if info.ParamsOneOf != nil {
			if parsed, err := info.ParamsOneOf.ToJSONSchema(); err == nil && parsed != nil {
				if raw, marshalErr := json.Marshal(parsed); marshalErr == nil {
					parameters = raw
				}
			}
		}
		out = append(out, aicore.ToolDefinition{Name: info.Name, Description: info.Desc, Parameters: parameters})
	}
	return out
}

func toEinoMessage(result *aicore.ChatResult, includeText bool) *schema.Message {
	message := &schema.Message{Role: schema.Assistant}
	if includeText {
		message.Content = result.Answer
	}
	for index, call := range result.ToolCalls {
		i := index
		message.ToolCalls = append(message.ToolCalls, schema.ToolCall{
			Index: &i,
			ID:    call.ID,
			Type:  "function",
			Function: schema.FunctionCall{
				Name: call.Name, Arguments: call.ArgsJSON,
			},
		})
	}
	message.ResponseMeta = &schema.ResponseMeta{
		Usage: &schema.TokenUsage{
			PromptTokens: int(result.InputTokens), CompletionTokens: int(result.OutputTokens),
			TotalTokens: int(result.InputTokens + result.OutputTokens),
		},
	}
	if len(result.ToolCalls) > 0 {
		message.ResponseMeta.FinishReason = "tool_calls"
	} else {
		message.ResponseMeta.FinishReason = "stop"
	}
	return message
}

type einoExecutorTool struct {
	definition    *AgentToolDefinition
	executionCtx  *ToolExecutionContext
	executor      *ToolExecutor
	controller    *SegmentController
	telemetry     *segmentTelemetry
	onToolOutcome func(*ToolRunOutcome)
}

var _ tool.InvokableTool = (*einoExecutorTool)(nil)

func (t *einoExecutorTool) Info(context.Context) (*schema.ToolInfo, error) {
	params := json.RawMessage(`{"type":"object","properties":{}}`)
	if len(t.definition.InputSchema) > 0 {
		params = t.definition.InputSchema
	}
	parsed := &jsonschema.Schema{}
	if err := json.Unmarshal(params, parsed); err != nil {
		return nil, fmt.Errorf("工具 %s 的 JSON Schema 无效: %w", t.definition.ID, err)
	}
	return &schema.ToolInfo{
		Name:        t.definition.Name,
		Desc:        t.definition.Description,
		ParamsOneOf: schema.NewParamsOneOfByJSONSchema(parsed),
	}, nil
}

func (t *einoExecutorTool) InvokableRun(ctx context.Context, argumentsInJSON string, _ ...tool.Option) (string, error) {
	if t.controller.Stopped() != nil {
		return "", errSegmentStopped
	}
	var input any = map[string]any{}
	if trimmed := strings.TrimSpace(argumentsInJSON); trimmed != "" {
		if err := json.Unmarshal([]byte(trimmed), &input); err != nil {
			// 保留原始非法参数，让统一 ToolExecutor 产生可修正的 validation observation，
			// 不能静默替换成空对象，否则可绕过 required/type 校验。
			input = argumentsInJSON
		}
	}
	outcome := t.executor.Execute(ctx, t.definition.ID, input, t.executionCtx)
	t.telemetry.markToolExecuted()
	if t.onToolOutcome != nil {
		t.onToolOutcome(&outcome)
	}
	// load_skill / StopPolicy 已把结果写入 Store。用哨兵终止本段，下一段会以新工具集重建图。
	if t.controller.Stopped() != nil {
		return "", errSegmentStopped
	}
	return ToModelResult(&outcome), nil
}

// scanStreamForToolCalls 读取 Eino 为分支复制出的流。aicore 会在文本帧之后才给出
// 聚合后的 tool_calls，因此不能使用 Eino 默认的“只看首帧”检查器。
func scanStreamForToolCalls(_ context.Context, stream *schema.StreamReader[*schema.Message]) (bool, error) {
	defer stream.Close()
	found := false
	for {
		message, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return found, nil
		}
		if err != nil {
			return false, err
		}
		if message != nil && len(message.ToolCalls) > 0 {
			found = true
		}
	}
}

func toEinoInput(request *SegmentRequest) []*schema.Message {
	messages := make([]*schema.Message, 0, len(request.Messages)+2)
	if request.Instructions != "" {
		messages = append(messages, schema.SystemMessage(request.Instructions))
	}
	for _, raw := range request.Messages {
		role, _ := raw["role"].(string)
		content, _ := raw["content"].(string)
		if role == "" && content == "" {
			continue
		}
		message := &schema.Message{Role: schema.RoleType(role), Content: content}
		message.ToolCallID, _ = raw["toolCallId"].(string)
		message.ToolName, _ = raw["toolName"].(string)
		if calls, exists := raw["toolCalls"]; exists {
			encoded, _ := json.Marshal(calls)
			var parsed []struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				ArgsJSON string `json:"argsJSON"`
			}
			if json.Unmarshal(encoded, &parsed) == nil {
				for index, call := range parsed {
					i := index
					message.ToolCalls = append(message.ToolCalls, schema.ToolCall{
						Index: &i, ID: call.ID, Type: "function",
						Function: schema.FunctionCall{Name: call.Name, Arguments: call.ArgsJSON},
					})
				}
			}
		}
		messages = append(messages, message)
	}
	if len(request.Messages) == 0 && request.Prompt != "" {
		messages = append(messages, schema.UserMessage(request.Prompt))
	}
	return messages
}

// RunAgentSegment 执行一段 Eino ReAct 推理；一次段内可含多轮工具调用。
func RunAgentSegment(ctx context.Context, request *SegmentRequest, controller *SegmentController) (*SegmentResult, error) {
	startedAt := nowMs()
	if request == nil || request.Model == nil {
		return nil, errors.New("缺少 Agent 模型")
	}
	if controller == nil {
		controller = NewSegmentController()
	}
	if err := ctx.Err(); err != nil {
		return &SegmentResult{Aborted: true, LlmMs: nowMs() - startedAt}, nil
	}

	telemetry := &segmentTelemetry{
		onTextDelta: request.OnTextDelta, onAnswerReset: request.OnAnswerReset,
	}
	einoTools := make([]tool.BaseTool, 0, len(request.Tools))
	for _, definition := range request.Tools {
		if definition == nil {
			continue
		}
		einoTools = append(einoTools, &einoExecutorTool{
			definition: definition, executionCtx: request.Ctx, executor: request.Executor,
			controller: controller, telemetry: telemetry, onToolOutcome: request.OnToolOutcome,
		})
	}

	maxModelSteps := request.MaxSteps
	if maxModelSteps < 1 {
		maxModelSteps = 1
	}
	// Eino 的 MaxStep 统计图节点：每轮工具调用是 chat + tools，最后再有一次 chat。
	maxGraphSteps := maxModelSteps*2 + 1
	chatModel := &einoChatModel{handle: request.Model, telemetry: telemetry}
	agent, err := react.NewAgent(ctx, &react.AgentConfig{
		ToolCallingModel: chatModel,
		ToolsConfig: compose.ToolsNodeConfig{
			Tools: einoTools,
			// Petrichor 的 State / Evidence / sequence 都要求确定顺序；并行委派由专门工具负责。
			ExecuteSequentially: true,
		},
		MaxStep:               maxGraphSteps,
		StreamToolCallChecker: scanStreamForToolCalls,
		GraphName:             request.AgentID,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Eino ReAct Agent 失败: %w", err)
	}

	options := []model.Option{}
	temperature := 0.2
	if request.Temperature != nil {
		temperature = *request.Temperature
	}
	options = append(options, model.WithTemperature(float32(temperature)))

	stream, err := agent.Stream(ctx, toEinoInput(request), react.WithChatModelOptions(options...))
	if err != nil {
		text, usage, toolCalls := telemetry.snapshot()
		result := &SegmentResult{
			Text: text, ToolCallCount: toolCalls, Usage: usage,
			Stopped: controller.Stopped(), Aborted: ctx.Err() != nil,
			LlmMs: nowMs() - startedAt,
		}
		if result.Stopped != nil || result.Aborted || errors.Is(err, errSegmentStopped) {
			return result, nil
		}
		return nil, err
	}
	defer stream.Close()

	finalChunks := make([]*schema.Message, 0, 8)
	for {
		message, recvErr := stream.Recv()
		if errors.Is(recvErr, io.EOF) {
			break
		}
		if recvErr != nil {
			text, usage, toolCalls := telemetry.snapshot()
			result := &SegmentResult{
				Text: text, ToolCallCount: toolCalls, Usage: usage,
				Stopped: controller.Stopped(), Aborted: ctx.Err() != nil,
				LlmMs: nowMs() - startedAt,
			}
			if result.Stopped != nil || result.Aborted || errors.Is(recvErr, errSegmentStopped) {
				return result, nil
			}
			return result, recvErr
		}
		if message != nil {
			finalChunks = append(finalChunks, message)
		}
	}

	text, usage, toolCalls := telemetry.snapshot()
	if text == "" && len(finalChunks) > 0 {
		if merged, mergeErr := schema.ConcatMessages(finalChunks); mergeErr == nil && merged != nil {
			text = merged.Content
		}
	}
	return &SegmentResult{
		Text: text, ToolCallCount: toolCalls, Usage: usage,
		Stopped: controller.Stopped(), Aborted: ctx.Err() != nil,
		LlmMs: nowMs() - startedAt,
	}, nil
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
