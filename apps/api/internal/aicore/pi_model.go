package aicore

import (
	"context"

	"petrichor/api/internal/piruntime"
)

// PiModel 把现有模型网关接入 Pi。供应商凭据从不跨越 Go 与 Pi 的边界。
func PiModel(runtime RuntimeConfig, modelID string, options GenerationOptions, tools []ToolDefinition) func(context.Context, []piruntime.Message, func(string) error) (*piruntime.ModelResult, error) {
	return func(ctx context.Context, input []piruntime.Message, onDelta func(string) error) (*piruntime.ModelResult, error) {
		messages := make([]ChatMessage, 0, len(input))
		for _, message := range input {
			converted := ChatMessage{Role: message.Role, Content: message.Content, ToolCallID: message.ToolCallID}
			for _, call := range message.ToolCalls {
				converted.ToolCalls = append(converted.ToolCalls, ToolCall{ID: call.ID, Name: call.Name, ArgsJSON: call.Arguments})
			}
			messages = append(messages, converted)
		}
		result, err := ChatWithTools(ctx, runtime, modelID, messages, options, tools, onDelta)
		if err != nil {
			return nil, err
		}
		out := &piruntime.ModelResult{Text: result.Answer, InputTokens: result.InputTokens, OutputTokens: result.OutputTokens}
		for _, call := range result.ToolCalls {
			out.ToolCalls = append(out.ToolCalls, piruntime.ToolCall{ID: call.ID, Name: call.Name, Arguments: call.ArgsJSON})
		}
		return out, nil
	}
}
