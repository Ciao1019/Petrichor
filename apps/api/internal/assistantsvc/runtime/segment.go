package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"unicode/utf8"

	aicore "petrichor/api/internal/aicore"
	"petrichor/api/internal/piruntime"
)

// 标准 Model → Tools → Model 循环由 Pi Agent Core 执行；
// Petrichor 保留状态、证据、权限和预算，所有工具仍通过 ToolExecutor。

// SegmentStopSignal 由 StopPolicy / SkillLoader 触发，要求提前结束本段推理。
type SegmentStopSignal struct {
	Reason string
}

// SegmentRequest 一段推理的入参。
type SegmentRequest struct {
	Controls     func(context.Context) ([]piruntime.Control, error)
	BeforeTool   func(*AgentToolDefinition, string) error
	AfterTool    func() error
	OnModelUsage func(int64, int64) error
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
	stopSignal *SegmentStopSignal
}

// NewSegmentController 构造。
func NewSegmentController() *SegmentController {
	return &SegmentController{}
}

// Request 请求在当前工具完成记录后、下一轮模型调用之前结束当前段。
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

// answerHoldRunes 工具轮次里正文的扣留长度。
//
// 模型常在发出 tool_calls 之前先写一句"我再补一次检索"这样的过程旁白，而 tool_calls
// 要等整轮结束才聚合出来——直接边收边发，旁白就已经落到用户屏幕上了。所以带工具的轮次
// 先把正文扣在手里：本轮确认没有工具调用才放行，确认调用工具就整段丢弃。
//
// 全程扣到轮次结束会让真正的答案迟迟不出现，因此扣留量超过这个长度就判定为正式作答并
// 转入直发。旁白通常只有一两句，正式答案则远长于此。
const answerHoldRunes = 120

// segmentTelemetry 汇总 Pi 多轮模型调用的数据，并保持流式回调与 Store 的顺序语义。
type segmentTelemetry struct {
	mu            sync.Mutex
	answer        strings.Builder
	held          strings.Builder
	heldRunes     int
	holdNarration bool
	streamed      bool
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
	if t.holdNarration && !t.streamed {
		t.held.WriteString(delta)
		t.heldRunes += utf8.RuneCountInString(delta)
		if t.heldRunes < answerHoldRunes {
			t.mu.Unlock()
			return
		}
		delta = t.held.String()
		t.held.Reset()
		t.heldRunes = 0
	}
	t.streamed = true
	t.mu.Unlock()
	if t.onTextDelta != nil {
		t.onTextDelta(delta)
	}
}

// releaseHeldText 本轮模型没有调用工具 → 扣住的正文就是正式回答，放行。
func (t *segmentTelemetry) releaseHeldText() {
	t.mu.Lock()
	text := t.held.String()
	t.held.Reset()
	t.heldRunes = 0
	if text != "" {
		t.streamed = true
	}
	t.mu.Unlock()
	if text != "" && t.onTextDelta != nil {
		t.onTextDelta(text)
	}
}

// markToolCalls 表示当前模型轮次最终选择了工具；此前输出的文本只是过程旁白。
// 还扣在手里的直接丢弃，用户不会看见；已经流出去的（旁白超长时才会发生）
// 只能靠前端换段丢弃。下一轮重新进入扣留状态。
func (t *segmentTelemetry) markToolCalls() {
	t.mu.Lock()
	hadAnswer := t.answer.Len() > 0
	if hadAnswer {
		t.answer.Reset()
	}
	leaked := t.streamed
	t.held.Reset()
	t.heldRunes = 0
	t.streamed = false
	t.mu.Unlock()
	if hadAnswer && leaked && t.onAnswerReset != nil {
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
