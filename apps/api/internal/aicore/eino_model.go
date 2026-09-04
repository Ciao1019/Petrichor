package aicore

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/schema"
)

// einoToolCallingModel 把统一多供应商协议适配为 Eino ADK 所需模型接口。
type einoToolCallingModel struct {
	runtime RuntimeConfig
	modelID string
	options GenerationOptions
	tools   []*schema.ToolInfo
}

var _ model.ToolCallingChatModel = (*einoToolCallingModel)(nil)

func newEinoToolCallingModel(resolved *ResolvedModel) *einoToolCallingModel {
	runtime := resolved.Runtime
	runtime.Quirks = ResolveQuirks(runtime.ProviderKey, resolved.ModelRef)
	return &einoToolCallingModel{
		runtime: runtime, modelID: resolved.ModelRef, options: resolved.Options,
	}
}

func (m *einoToolCallingModel) WithTools(tools []*schema.ToolInfo) (model.ToolCallingChatModel, error) {
	copyModel := *m
	copyModel.tools = append([]*schema.ToolInfo(nil), tools...)
	return &copyModel, nil
}

func (m *einoToolCallingModel) Generate(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.Message, error) {
	messages, tools, generation := m.prepare(input, opts...)
	var (
		result *ChatResult
		err    error
	)
	if len(tools) > 0 {
		result, err = ChatWithToolsOnce(ctx, m.runtime, m.modelID, messages, generation, tools)
	} else {
		result, err = Chat(ctx, m.runtime, m.modelID, messages, generation)
	}
	if err != nil {
		return nil, err
	}
	return documentAgentEinoMessage(result), nil
}

func (m *einoToolCallingModel) Stream(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	message, err := m.Generate(ctx, input, opts...)
	if err != nil {
		return nil, err
	}
	return schema.StreamReaderFromArray([]*schema.Message{message}), nil
}

func (m *einoToolCallingModel) prepare(input []*schema.Message, opts ...model.Option) ([]ChatMessage, []ToolDefinition, GenerationOptions) {
	base := &model.Options{Tools: append([]*schema.ToolInfo(nil), m.tools...)}
	common := model.GetCommonOptions(base, opts...)
	generation := m.options
	if common.Temperature != nil {
		text := strconv.FormatFloat(float64(*common.Temperature), 'g', -1, 32)
		value, parseErr := strconv.ParseFloat(text, 64)
		if parseErr == nil {
			generation.Temperature = &value
		}
	}
	if common.MaxTokens != nil {
		value := int64(*common.MaxTokens)
		generation.MaxTokens = &value
	}
	return documentAgentMessagesFromEino(input), documentAgentToolsFromEino(common.Tools), generation
}

func documentAgentMessagesFromEino(messages []*schema.Message) []ChatMessage {
	out := make([]ChatMessage, 0, len(messages))
	for _, message := range messages {
		if message == nil {
			continue
		}
		converted := ChatMessage{
			Role: string(message.Role), Content: message.Content, ToolCallID: message.ToolCallID,
		}
		for _, call := range message.ToolCalls {
			converted.ToolCalls = append(converted.ToolCalls, ToolCall{
				ID: call.ID, Name: call.Function.Name, ArgsJSON: call.Function.Arguments,
			})
		}
		out = append(out, converted)
	}
	return out
}

func documentAgentToolsFromEino(infos []*schema.ToolInfo) []ToolDefinition {
	out := make([]ToolDefinition, 0, len(infos))
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
		out = append(out, ToolDefinition{Name: info.Name, Description: info.Desc, Parameters: parameters})
	}
	return out
}

func documentAgentEinoMessage(result *ChatResult) *schema.Message {
	message := &schema.Message{Role: schema.Assistant, Content: result.Answer}
	for index, call := range result.ToolCalls {
		i := index
		message.ToolCalls = append(message.ToolCalls, schema.ToolCall{
			Index: &i, ID: call.ID, Type: "function",
			Function: schema.FunctionCall{Name: call.Name, Arguments: call.ArgsJSON},
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
