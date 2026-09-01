package assistantsvc

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

const (
	agentEventPartType     = "data-agent-event"
	intentRoutePartType    = "data-intent-route"
	contextCompressPartTyp = "data-context-compress"
	stepBudgetPartType     = "data-step-budget"
	agentAnswerTextID      = "agent-answer"
)

// dataPartID 高频 delta 复用同一个 data part，其余按 sequence 唯一。
func dataPartID(event *rt.AgentStreamEvent) string {
	if event.Type == "final_answer_delta" {
		return event.RunID + ":answer-delta"
	}
	return event.RunID + ":" + strconv.FormatInt(int64(event.Sequence), 10)
}

// newStreamMessageID 生成流首帧的 messageId（对应 AI SDK 自动生成的 id 形状）。
func newStreamMessageID() string {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("go-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

type assistantStreamParts struct {
	mu    sync.Mutex
	parts []map[string]any
	byID  map[string]int
	text  bool
}

func newAssistantStreamParts() *assistantStreamParts {
	return &assistantStreamParts{parts: []map[string]any{}, byID: map[string]int{}}
}

// addData 复刻 AI SDK data part 的 id 更新语义：相同 id 原位覆盖，所以高频 delta
// 在落库消息里只保留最后一帧，其余事件仍按首次出现顺序可重放。
func (p *assistantStreamParts) addData(id string, data map[string]any) {
	p.addTypedData(agentEventPartType, id, data)
}

func (p *assistantStreamParts) addTypedData(partType, id string, data map[string]any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	part := map[string]any{"type": partType, "id": id, "data": data}
	if index, exists := p.byID[id]; exists {
		p.parts[index] = part
		return
	}
	p.byID[id] = len(p.parts)
	p.parts = append(p.parts, part)
}

func (p *assistantStreamParts) addText(text string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.text || text == "" {
		return
	}
	p.text = true
	p.parts = append(p.parts, map[string]any{"type": "text", "text": text})
}

func (p *assistantStreamParts) addTool(id, name string, input, output any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	part := map[string]any{
		"type": "tool-" + name, "toolCallId": id, "state": "output-available",
		"input": input, "output": output,
	}
	if index, exists := p.byID[id]; exists {
		p.parts[index] = part
		return
	}
	p.byID[id] = len(p.parts)
	p.parts = append(p.parts, part)
}

func (p *assistantStreamParts) all() []map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]map[string]any{}, p.parts...)
}

func (p *assistantStreamParts) len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.parts)
}

// assistantEventBridge 对齐 TS createAgentEventWriter：过程 delta 只进入结构化
// data part；final_answer_completed 才落唯一一段标准 text。completed 未携带 text
// 时使用本段 delta 缓冲兜底，且新的 final_answer_started 会丢弃旧段缓冲。
type assistantEventBridge struct {
	emit             func(any) bool
	parts            *assistantStreamParts
	answerBuffer     string
	finalTextWritten bool
}

func newAssistantEventBridge(emit func(any) bool, parts *assistantStreamParts) *assistantEventBridge {
	return &assistantEventBridge{emit: emit, parts: parts}
}

func (b *assistantEventBridge) onEvent(event *rt.AgentStreamEvent) bool {
	publicEvent := publicAgentEvent(event)
	payload, _ := publicEvent["payload"].(map[string]any)
	if payload == nil {
		payload = map[string]any{}
	}

	switch event.Type {
	case "final_answer_started":
		b.answerBuffer = ""
	case "final_answer_delta":
		if delta, ok := payload["delta"].(string); ok {
			b.answerBuffer += delta
		}
	case "final_answer_completed":
		text, exists := payload["text"].(string)
		if !exists {
			text = b.answerBuffer
		}
		b.answerBuffer = text
		if text != "" && !b.finalTextWritten {
			b.finalTextWritten = true
			b.parts.addText(text)
			if !b.emit(map[string]any{"type": "text-start", "id": agentAnswerTextID}) {
				return false
			}
			if !b.emit(map[string]any{"type": "text-delta", "id": agentAnswerTextID, "delta": text}) {
				return false
			}
			if !b.emit(map[string]any{"type": "text-end", "id": agentAnswerTextID}) {
				return false
			}
		}
	}

	partID := dataPartID(event)
	if event.Type == "step_budget" {
		payload, _ := publicEvent["payload"].(map[string]any)
		if payload == nil {
			payload = map[string]any{}
		}
		b.parts.addTypedData(stepBudgetPartType, partID, payload)
		return b.emit(map[string]any{"type": stepBudgetPartType, "id": partID, "data": payload})
	}
	b.parts.addData(partID, publicEvent)
	return b.emit(map[string]any{"type": agentEventPartType, "id": partID, "data": publicEvent})
}

// emitAssistantDataPart 发送并记录一个非 Agent 事件的 data part。
func emitAssistantDataPart(
	emitter *sseEmitter,
	parts *assistantStreamParts,
	partType, id string,
	data map[string]any,
) bool {
	parts.addTypedData(partType, id, data)
	return emitter.chunk(map[string]any{"type": partType, "id": id, "data": data})
}

// buildAssistantPersistContent 组装落库 content（对齐 TS 的完整 parts + agentRunId + usage）。
func buildAssistantPersistContent(result *rt.RunResult, runKey string, parts []map[string]any, startedAt time.Time) json.RawMessage {
	content := map[string]any{
		"parts": parts,
	}
	if runKey != "" {
		content["agentRunId"] = runKey
	}
	usage := map[string]any{}
	if result != nil && result.State != nil {
		tu := result.State.TokenUsage
		if tu.Input > 0 {
			usage["inputTokens"] = tu.Input
		}
		if tu.Output > 0 {
			usage["outputTokens"] = tu.Output
		}
		if tu.Total > 0 {
			usage["totalTokens"] = tu.Total
		}
		if len(usage) > 0 {
			content["usage"] = usage
		}
	}
	totalMs := time.Since(startedAt).Milliseconds()
	if totalMs > 0 {
		content["totalStreamTime"] = totalMs
		if out, ok := usage["outputTokens"].(int64); ok && out > 0 {
			content["tokensPerSecond"] = float64(out) / (float64(totalMs) / 1000)
		}
	}
	raw, err := json.Marshal(content)
	if err != nil {
		return json.RawMessage(`{"parts":[]}`)
	}
	return raw
}

// uiMessagesToRuntime 把 UIMessage 转成 Runtime 消息。除标准 text 外，还保留
// 已完成的历史工具调用/结果（含确认卡 executionOutcome）；否则后续轮次会忘记
// 已执行的操作，甚至再次请求确认。未完成的工具调用不进入模型，避免构造出
// 没有对应 tool result 的非法供应商消息。
func uiMessagesToRuntime(messages []json.RawMessage) []map[string]any {
	out := make([]map[string]any, 0, len(messages)*2)
	for messageIndex, raw := range messages {
		var env struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
			Parts   json.RawMessage `json:"parts"`
		}
		if json.Unmarshal(raw, &env) != nil {
			continue
		}
		texts := []string{}
		var str string
		if isJSONString(env.Content) && json.Unmarshal(env.Content, &str) == nil {
			texts = append(texts, str)
		} else {
			parts := env.Parts
			if !isJSONArray(parts) {
				parts = env.Content
			}
			texts = append(texts, collectTextParts(parts)...)
		}
		text := strings.Join(filterNonEmpty(texts), "\n")

		parts := env.Parts
		if !isJSONArray(parts) {
			parts = env.Content
		}
		toolPairs := collectHistoricalToolPairs(parts, messageIndex)
		if env.Role == "assistant" && len(toolPairs) > 0 {
			calls := make([]map[string]any, 0, len(toolPairs))
			for _, pair := range toolPairs {
				calls = append(calls, map[string]any{
					"id": pair.ID, "name": pair.Name, "argsJSON": pair.ArgsJSON,
				})
			}
			out = append(out, map[string]any{"role": "assistant", "content": text, "toolCalls": calls})
			for _, pair := range toolPairs {
				out = append(out, map[string]any{
					"role": "tool", "content": pair.ResultJSON,
					"toolCallId": pair.ID, "toolName": pair.Name,
				})
			}
			continue
		}
		if strings.TrimSpace(text) != "" {
			out = append(out, map[string]any{"role": env.Role, "content": text})
		}
	}
	return out
}

type historicalToolPair struct {
	ID         string
	Name       string
	ArgsJSON   string
	ResultJSON string
}

func collectHistoricalToolPairs(parts json.RawMessage, messageIndex int) []historicalToolPair {
	var items []map[string]any
	if json.Unmarshal(parts, &items) != nil {
		return nil
	}
	out := []historicalToolPair{}
	for partIndex, part := range items {
		name := historicalToolName(part)
		if name == "" {
			continue
		}
		input := firstHistoricalPartValue(part, "input", "args")
		result := firstHistoricalPartValue(part, "output", "result")
		if invocation, ok := part["toolInvocation"].(map[string]any); ok {
			if input == nil {
				input = firstHistoricalPartValue(invocation, "input", "args")
			}
			if result == nil {
				result = firstHistoricalPartValue(invocation, "output", "result")
			}
		}
		if result == nil {
			if errorText, ok := part["errorText"].(string); ok && errorText != "" {
				result = map[string]any{"error": errorText}
			} else {
				// 只保留完整 call/result 对，所有原生协议都要求严格配对。
				continue
			}
		}
		id, _ := part["toolCallId"].(string)
		if id == "" {
			if invocation, ok := part["toolInvocation"].(map[string]any); ok {
				id, _ = invocation["toolCallId"].(string)
			}
		}
		if id == "" {
			id = fmt.Sprintf("history-%d-%d", messageIndex, partIndex)
		}
		if input == nil {
			input = map[string]any{}
		}
		argsJSON, argsErr := json.Marshal(input)
		resultJSON, resultErr := json.Marshal(result)
		if argsErr != nil || resultErr != nil {
			continue
		}
		out = append(out, historicalToolPair{ID: id, Name: name, ArgsJSON: string(argsJSON), ResultJSON: string(resultJSON)})
	}
	return out
}

func historicalToolName(part map[string]any) string {
	if name, ok := part["toolName"].(string); ok && name != "" {
		return name
	}
	if invocation, ok := part["toolInvocation"].(map[string]any); ok {
		if name, ok := invocation["toolName"].(string); ok && name != "" {
			return name
		}
	}
	typeName, _ := part["type"].(string)
	if strings.HasPrefix(typeName, "tool-") && typeName != "tool-call" && typeName != "tool-invocation" {
		return strings.TrimPrefix(typeName, "tool-")
	}
	return ""
}

func firstHistoricalPartValue(part map[string]any, keys ...string) any {
	for _, key := range keys {
		if value, exists := part[key]; exists && value != nil {
			return value
		}
	}
	return nil
}

// ===== 消息转换 =====

type uiMessageEnvelope struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Parts   json.RawMessage `json:"parts"`
}

func messageRoleIs(raw json.RawMessage, role string) bool {
	var env uiMessageEnvelope
	if json.Unmarshal(raw, &env) != nil {
		return false
	}
	return env.Role == role
}

// extractLastUserText 对照 chat-handler.ts extractLastUserText：
// 从后往前找第一条有文本的 user 消息；文本取 content 字符串或 text parts 以 \n 连接。
func extractLastUserText(messages []json.RawMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if !messageRoleIs(messages[i], "user") {
			continue
		}
		var env uiMessageEnvelope
		if json.Unmarshal(messages[i], &env) != nil {
			continue
		}
		var str string
		if isJSONString(env.Content) && json.Unmarshal(env.Content, &str) == nil && strings.TrimSpace(str) != "" {
			return strings.TrimSpace(str)
		}
		parts := env.Parts
		if !isJSONArray(parts) {
			parts = env.Content
		}
		if !isJSONArray(parts) {
			continue
		}
		joined := strings.Join(filterNonEmpty(collectTextParts(parts)), "\n")
		if strings.TrimSpace(joined) != "" {
			return strings.TrimSpace(joined)
		}
	}
	return ""
}

// collectTextParts 提取 parts 数组里 type=="text" 的 text 字段。
func collectTextParts(parts json.RawMessage) []string {
	var items []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(parts, &items) != nil {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item.Type == "text" {
			out = append(out, item.Text)
		}
	}
	return out
}

// ===== 小工具 =====

func filterNonEmpty(in []string) []string {
	out := make([]string, 0, len(in))
	for _, v := range in {
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func jsonArrayLen(raw json.RawMessage) int { return len(jsonArrayItems(raw)) }

func jsonArrayItems(raw json.RawMessage) []json.RawMessage {
	if !isJSONArray(raw) {
		return nil
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) != nil {
		return nil
	}
	return items
}
