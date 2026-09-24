package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/piruntime"
)

func toPiInput(request *SegmentRequest) []piruntime.Message {
	messages := make([]piruntime.Message, 0, len(request.Messages)+2)
	if request.Instructions != "" {
		messages = append(messages, piruntime.Message{Role: "system", Content: request.Instructions})
	}
	for _, raw := range request.Messages {
		role, _ := raw["role"].(string)
		content, _ := raw["content"].(string)
		if role == "" && content == "" {
			continue
		}
		message := piruntime.Message{Role: role, Content: content}
		message.ToolCallID, _ = raw["toolCallId"].(string)
		message.ToolName, _ = raw["toolName"].(string)
		if calls, ok := raw["toolCalls"]; ok {
			encoded, _ := json.Marshal(calls)
			var parsed []struct {
				ID       string `json:"id"`
				Name     string `json:"name"`
				ArgsJSON string `json:"argsJSON"`
			}
			if json.Unmarshal(encoded, &parsed) == nil {
				for _, call := range parsed {
					message.ToolCalls = append(message.ToolCalls, piruntime.ToolCall{ID: call.ID, Name: call.Name, Arguments: call.ArgsJSON})
				}
			}
		}
		messages = append(messages, message)
	}
	if len(request.Messages) == 0 && request.Prompt != "" {
		messages = append(messages, piruntime.Message{Role: "user", Content: request.Prompt})
	}
	return messages
}

// RunAgentSegment 用 Pi 执行主助手和子 Agent 的一次推理段。
// 加载技能或命中停止策略时同步结束进程，下一段使用最新工具集和上下文。
func RunAgentSegment(ctx context.Context, request *SegmentRequest, controller *SegmentController) (*SegmentResult, error) {
	startedAt := nowMs()
	if request == nil || request.Model == nil {
		return nil, errors.New("缺少 Agent 模型")
	}
	if controller == nil {
		controller = NewSegmentController()
	}
	if ctx.Err() != nil {
		return &SegmentResult{Aborted: true}, nil
	}
	if stopped := controller.Stopped(); stopped != nil {
		return &SegmentResult{Stopped: stopped}, nil
	}
	telemetry := &segmentTelemetry{onTextDelta: request.OnTextDelta, onAnswerReset: request.OnAnswerReset}
	tools := []piruntime.Tool{}
	modelTools := []aicore.ToolDefinition{}
	definitions := map[string]*AgentToolDefinition{}
	for _, definition := range request.Tools {
		if definition == nil {
			continue
		}
		if request.Executor == nil || request.Ctx == nil {
			return nil, errors.New("缺少 Agent 工具执行上下文")
		}
		params := definition.InputSchema
		if len(params) == 0 {
			params = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		tools = append(tools, piruntime.Tool{Name: definition.Name, Description: definition.Description, Parameters: params})
		modelTools = append(modelTools, aicore.ToolDefinition{Name: definition.Name, Description: definition.Description, Parameters: params})
		definitions[definition.Name] = definition
	}
	telemetry.holdNarration = len(tools) > 0
	options := request.Model.Options
	temperature := 0.2
	if request.Temperature != nil {
		temperature = *request.Temperature
	}
	options.Temperature = &temperature
	model := aicore.PiModel(request.Model.Runtime, request.Model.ModelID, options, modelTools)
	lastModelWasAnswer := false
	_, err := piruntime.Run(ctx, piruntime.Request{
		Controls: func(c context.Context) ([]piruntime.Control, error) {
			if request.Controls == nil {
				return nil, nil
			}
			controls, err := request.Controls(c)
			if len(controls) > 0 {
				telemetry.markToolCalls()
			}
			return controls, err
		},
		Messages: toPiInput(request), Tools: tools, MaxTurns: request.MaxSteps,
		Model: func(ctx context.Context, messages []piruntime.Message, delta func(string) error) (*piruntime.ModelResult, error) {
			if controller.Stopped() != nil {
				return nil, errSegmentStopped
			}
			if lastModelWasAnswer {
				telemetry.markToolCalls()
			}
			result, err := model(ctx, messages, func(text string) error { telemetry.addDelta(text); return delta(text) })
			if err != nil {
				return nil, err
			}
			telemetry.addUsage(result.InputTokens, result.OutputTokens)
			lastModelWasAnswer = len(result.ToolCalls) == 0
			if request.OnModelUsage != nil {
				if err := request.OnModelUsage(result.InputTokens, result.OutputTokens); err != nil {
					return nil, err
				}
			}
			if len(result.ToolCalls) > 0 {
				telemetry.markToolCalls()
			} else {
				telemetry.releaseHeldText()
			}
			return result, nil
		},
		Execute: func(ctx context.Context, call piruntime.ToolCall) (piruntime.ToolResult, error) {
			if controller.Stopped() != nil {
				return piruntime.ToolResult{}, errSegmentStopped
			}
			definition := definitions[call.Name]
			if definition == nil {
				return piruntime.ToolResult{}, errors.New("未知的 Agent 工具")
			}
			var input any = map[string]any{}
			if strings.TrimSpace(call.Arguments) != "" {
				if json.Unmarshal([]byte(call.Arguments), &input) != nil {
					input = call.Arguments
				}
			}
			if request.BeforeTool != nil {
				if err := request.BeforeTool(definition, call.ID); err != nil {
					return piruntime.ToolResult{}, err
				}
			}
			outcome := request.Executor.Execute(ctx, definition.ID, input, request.Ctx)
			if request.AfterTool != nil {
				if err := request.AfterTool(); err != nil {
					return piruntime.ToolResult{}, err
				}
			}
			telemetry.markToolExecuted()
			if request.OnToolOutcome != nil {
				request.OnToolOutcome(&outcome)
			}
			if controller.Stopped() != nil {
				return piruntime.ToolResult{}, errSegmentStopped
			}
			return piruntime.ToolResult{Text: ToModelResult(&outcome), IsError: !outcome.OK}, nil
		},
	})
	if errors.Is(err, piruntime.ErrTurnLimit) {
		controller.Request("stop_policy:" + string(StopMaxIterations))
	}
	text, usage, toolCalls := telemetry.snapshot()
	result := &SegmentResult{Text: text, ToolCallCount: toolCalls, Usage: usage,
		Stopped: controller.Stopped(), Aborted: ctx.Err() != nil, LlmMs: nowMs() - startedAt}
	if result.Stopped != nil || result.Aborted {
		return result, nil
	}
	return result, err
}
