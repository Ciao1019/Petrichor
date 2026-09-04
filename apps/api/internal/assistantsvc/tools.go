package assistantsvc

// tools.go 负责 Agent 工具装配。
//
// 所有工具统一注册进 runtime.DefaultToolRegistry()；执行体走 ToolExecutor，
// 不存在绕过执行器的调用路径。

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func toolPtr(v bool) *bool { return &v }

func boolPtr(v bool) *bool { return &v }

func joinStrings(parts []string, sep string) string {
	return strings.Join(parts, sep)
}

func itoa(n int) string { return strconv.Itoa(n) }

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

func floatPtr(v float64) *float64 { return &v }

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func stringSliceValue(value any) []string {
	raw, _ := value.([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok && text != "" {
			out = append(out, text)
		}
	}
	return out
}

func intValue(value any) int {
	switch number := value.(type) {
	case float64:
		return int(number)
	case json.Number:
		parsed, _ := strconv.Atoi(number.String())
		return parsed
	case int:
		return number
	default:
		return 0
	}
}

func schemaJSON(schema string) json.RawMessage { return json.RawMessage(schema) }

// toolContext 的 fallback 仅供不经过 HTTP 的内部调用与单元测试；聊天主链路总是注入 Request.Context。
func toolContext(ctx *rt.ToolExecutionContext) context.Context {
	if ctx != nil && ctx.Context != nil {
		return ctx.Context
	}
	return context.Background()
}

// RegisterAssistantTools 注册助手域全部工具与技能（进程内一次）。
func RegisterAssistantTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}, skills interface {
	Register(skill rt.AgentSkill)
}) {
	registerSystemTools(registry)
	registerKnowledgeTools(registry)
	registerDocumentTools(registry)
	registerMemoryTools(registry)
	registerResearchTools(registry)
	registerWriterTools(registry)
	registerAdminTools(registry)
	registerAgentMetaTools(registry)
	registerConfirmationTools(registry)
	registerBuiltinSkills(skills)
}

// ===== knowledge 域 =====
