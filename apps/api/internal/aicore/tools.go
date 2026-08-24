package aicore

import (
	"encoding/json"
)

// ===== 工具调用协议类型（对应 TS 中 AI SDK/Mastra 提供的 tool-calling 能力）=====

// ToolDefinition 注册给模型的工具定义。
type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"` // JSON Schema 对象
}

// ToolCall 模型发起的一次工具调用。
type ToolCall struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ArgsJSON string `json:"arguments"` // 原始 JSON 字符串
}

// toolCallAcc 流式聚合中的 tool_call 累积器。
type toolCallAcc struct {
	id   string
	name string
	args string
}

func openAIToolsPayload(tools []ToolDefinition) []map[string]any {
	if len(tools) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(tools))
	for _, t := range tools {
		params := t.Parameters
		if len(params) == 0 {
			params = json.RawMessage(`{"type":"object","properties":{}}`)
		}
		out = append(out, map[string]any{
			"type":     "function",
			"function": map[string]any{"name": t.Name, "description": t.Description, "parameters": params},
		})
	}
	return out
}
