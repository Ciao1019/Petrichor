package runtime

import (
	"encoding/json"
	"regexp"
	"strings"
)

// ===== 流式事件协议（对照 events.ts）=====

// AgentStreamEvent 前端结构化事件。sequence 单调递增，同一 runId 的事件可重放恢复整个 Run 视图。
type AgentStreamEvent struct {
	RunID     string          `json:"runId"`
	Sequence  int             `json:"sequence"`
	Type      string          `json:"type"`
	Timestamp int64           `json:"timestamp"`
	Payload   json.RawMessage `json:"payload"`
}

// AgentRunMetrics Run 指标。
type AgentRunMetrics struct {
	DurationMs    int64 `json:"durationMs"`
	ToolCalls     int   `json:"toolCalls"`
	EvidenceCount int   `json:"evidenceCount"`
	SubAgentCount int   `json:"subAgentCount"`
	Iterations    int   `json:"iterations"`
}

// PublicObservation 对普通 UI 暴露的观察（不含 raw args / 内部 prompt）。
type PublicObservation struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Source    string `json:"source"`
	Summary   string `json:"summary"`
	IsError   bool   `json:"isError,omitempty"`
	CreatedAt int64  `json:"createdAt"`
}

// PublicEvidence 对普通 UI 暴露的证据。
type PublicEvidence struct {
	ID              string   `json:"id"`
	Source          string   `json:"source"`
	Title           string   `json:"title"`
	Snippet         string   `json:"snippet,omitempty"`
	URL             string   `json:"url,omitempty"`
	NodeKey         string   `json:"nodeKey,omitempty"`
	ArticleID       string   `json:"articleId,omitempty"`
	KnowledgeBaseID string   `json:"knowledgeBaseId,omitempty"`
	Path            []string `json:"path,omitempty"`
	Relevance       *float64 `json:"relevance,omitempty"`
}

// ToPublicObservation 转公开观察。
func ToPublicObservation(o AgentObservation) PublicObservation {
	return PublicObservation{
		ID:        o.ID,
		Type:      o.Type,
		Source:    o.Source,
		Summary:   o.Summary,
		IsError:   o.IsError,
		CreatedAt: o.CreatedAt,
	}
}

// ToPublicEvidence 转公开证据。
func ToPublicEvidence(e AgentEvidence) PublicEvidence {
	title := e.Title
	if title == "" {
		r := []rune(e.Content)
		if len(r) > 60 {
			r = r[:60]
		}
		title = string(r)
	}
	out := PublicEvidence{
		ID:        e.ID,
		Source:    string(e.Source),
		Title:     title,
		Relevance: e.Relevance,
	}
	if e.Content != "" {
		r := []rune(e.Content)
		if len(r) > 280 {
			r = r[:280]
		}
		out.Snippet = string(r)
	}
	if e.URL != "" {
		out.URL = e.URL
	}
	meta := func(key string) string {
		if v, ok := e.Metadata[key].(string); ok {
			return v
		}
		return ""
	}
	if v := meta("nodeKey"); v != "" {
		out.NodeKey = v
	}
	if v := meta("articleId"); v != "" {
		out.ArticleID = v
	}
	if v := meta("knowledgeBaseId"); v != "" {
		out.KnowledgeBaseID = v
	}
	if path, ok := e.Metadata["path"].([]any); ok && len(path) > 0 {
		parts := make([]string, 0, len(path))
		for _, p := range path {
			if s, ok := p.(string); ok {
				parts = append(parts, s)
			}
		}
		out.Path = parts
	}
	return out
}

// EventSink 事件回调。
type EventSink func(event *AgentStreamEvent)

// AgentEventEmitter 事件发射器：统一分配 sequence 与时间戳。
type AgentEventEmitter struct {
	runID    string
	sink     EventSink
	sequence int
}

// NewAgentEventEmitter 构造。
func NewAgentEventEmitter(runID string, sink EventSink) *AgentEventEmitter {
	return &AgentEventEmitter{runID: runID, sink: sink}
}

// Emit 发射事件。
func (e *AgentEventEmitter) Emit(eventType string, payload any) *AgentStreamEvent {
	e.sequence++
	raw, err := json.Marshal(payload)
	if err != nil {
		raw = json.RawMessage("{}")
	}
	event := &AgentStreamEvent{
		RunID:     e.runID,
		Sequence:  e.sequence,
		Type:      eventType,
		Timestamp: nowMs(),
		Payload:   raw,
	}
	if e.sink != nil {
		e.sink(event)
	}
	return event
}

// LastSequence 当前序号。
func (e *AgentEventEmitter) LastSequence() int { return e.sequence }

// ===== Trace 收集（对照 trace.ts）=====

// AgentTraceEvent trace 事件。
type AgentTraceEvent struct {
	ID        string         `json:"id"`
	RunID     string         `json:"runId"`
	Sequence  int            `json:"sequence"`
	Type      string         `json:"type"`
	Payload   map[string]any `json:"payload"`
	CreatedAt int64          `json:"createdAt"`
}

// AgentToolTrace 工具调用 trace。
type AgentToolTrace struct {
	ID                 string             `json:"id"`
	ToolID             string             `json:"toolId"`
	ToolName           string             `json:"toolName"`
	Namespace          string             `json:"namespace"`
	Input              any                `json:"input"`
	RawOutput          any                `json:"rawOutput,omitempty"`
	Summary            string             `json:"summary,omitempty"`
	OK                 bool               `json:"ok"`
	ErrorCode          AgentToolErrorCode `json:"errorCode,omitempty"`
	DurationMs         int64              `json:"durationMs"`
	Retries            int                `json:"retries"`
	EvidenceIDs        []string           `json:"evidenceIds"`
	PermissionDecision string             `json:"permissionDecision"`
	StartedAt          int64              `json:"startedAt"`
}

// AgentSkillTrace 技能加载 trace。
type AgentSkillTrace struct {
	SkillID  string   `json:"skillId"`
	LoadedAt int64    `json:"loadedAt"`
	ToolIDs  []string `json:"toolIds"`
}

// AgentDelegationTrace 委派 trace。
type AgentDelegationTrace struct {
	TaskID        string `json:"taskId"`
	Objective     string `json:"objective"`
	Status        string `json:"status"`
	Depth         int    `json:"depth"`
	DurationMs    int64  `json:"durationMs"`
	EvidenceCount int    `json:"evidenceCount"`
	TraceID       string `json:"traceId"`
}

// AgentLatencyMetrics 延迟指标。
type AgentLatencyMetrics struct {
	TtftMs      *int64 `json:"ttftMs,omitempty"`
	TotalMs     *int64 `json:"totalMs,omitempty"`
	LlmMs       *int64 `json:"llmMs,omitempty"`
	ToolMs      *int64 `json:"toolMs,omitempty"`
	SubAgentMs  *int64 `json:"subAgentMs,omitempty"`
	RetrievalMs *int64 `json:"retrievalMs,omitempty"`
	RerankMs    *int64 `json:"rerankMs,omitempty"`
}

// AgentTrace 完整 trace。
type AgentTrace struct {
	RunID          string                 `json:"runId"`
	ConversationID string                 `json:"conversationId"`
	UserID         string                 `json:"userId"`
	Model          string                 `json:"model"`
	RoutingHint    *RoutingHint           `json:"routingHint,omitempty"`
	Complexity     TaskComplexity         `json:"complexity"`
	Steps          []AgentTraceEvent      `json:"steps"`
	ToolCalls      []AgentToolTrace       `json:"toolCalls"`
	SkillLoads     []AgentSkillTrace      `json:"skillLoads"`
	Delegations    []AgentDelegationTrace `json:"delegations"`
	EvidenceIDs    []string               `json:"evidenceIds"`
	TokenUsage     AgentTokenUsage        `json:"tokenUsage"`
	Latency        AgentLatencyMetrics    `json:"latency"`
	StartedAt      int64                  `json:"startedAt"`
	CompletedAt    int64                  `json:"completedAt,omitempty"`
	TotalLatencyMs int64                  `json:"totalLatencyMs,omitempty"`
	StopReason     AgentStopReason        `json:"stopReason,omitempty"`
}

// TraceCollector Run 级 Trace 收集：原始 Tool Result 只落在这里，不进 LLM Context。
type TraceCollector struct {
	runID          string
	conversationID string
	userID         string
	model          string
	startedAt      int64

	events      []AgentTraceEvent
	toolCalls   []AgentToolTrace
	skillLoads  []AgentSkillTrace
	delegations []AgentDelegationTrace
	evidenceIDs map[string]bool
	latency     AgentLatencyMetrics
	tokenUsage  AgentTokenUsage
	sequence    int
	stopReason  AgentStopReason
	completedAt int64
	routingHint *RoutingHint
	complexity  TaskComplexity
}

// NewTraceCollector 构造。
func NewTraceCollector(runID, conversationID, userID, model string, startedAt int64) *TraceCollector {
	if startedAt <= 0 {
		startedAt = nowMs()
	}
	return &TraceCollector{
		runID:          runID,
		conversationID: conversationID,
		userID:         userID,
		model:          model,
		startedAt:      startedAt,
		events:         []AgentTraceEvent{},
		toolCalls:      []AgentToolTrace{},
		skillLoads:     []AgentSkillTrace{},
		delegations:    []AgentDelegationTrace{},
		evidenceIDs:    map[string]bool{},
		complexity:     ComplexitySimple,
	}
}

// Event 记录事件。
func (t *TraceCollector) Event(eventType string, payload map[string]any) *AgentTraceEvent {
	t.sequence++
	if payload == nil {
		payload = map[string]any{}
	}
	event := AgentTraceEvent{
		ID:        NewID("tev"),
		RunID:     t.runID,
		Sequence:  t.sequence,
		Type:      eventType,
		Payload:   redactMap(payload).(map[string]any),
		CreatedAt: nowMs(),
	}
	t.events = append(t.events, event)
	return &event
}

// SetRoutingHint 登记路由提示。
func (t *TraceCollector) SetRoutingHint(hint RoutingHint) {
	t.routingHint = &hint
	t.Event("routing_hint", map[string]any{"domains": hint.Domains, "confidence": hint.Confidence})
}

// SetComplexity 登记复杂度。
func (t *TraceCollector) SetComplexity(complexity TaskComplexity, reason string) {
	t.complexity = complexity
	payload := map[string]any{"complexity": complexity}
	if reason != "" {
		payload["reason"] = reason
	}
	t.Event("complexity_decided", payload)
}

// RecordToolCall 登记工具调用。
func (t *TraceCollector) RecordToolCall(trace AgentToolTrace) {
	trace.Input = redact(trace.Input)
	trace.RawOutput = redact(trace.RawOutput)
	for _, id := range trace.EvidenceIDs {
		t.evidenceIDs[id] = true
	}
	t.latency.ToolMs = addMs(t.latency.ToolMs, trace.DurationMs)
	t.toolCalls = append(t.toolCalls, trace)
}

// RecordSkillLoad 登记技能加载。
func (t *TraceCollector) RecordSkillLoad(trace AgentSkillTrace) {
	t.skillLoads = append(t.skillLoads, trace)
	t.Event("skill_loaded", map[string]any{"skillId": trace.SkillID, "toolIds": trace.ToolIDs})
}

// RecordDelegation 登记委派。
func (t *TraceCollector) RecordDelegation(trace AgentDelegationTrace) {
	t.delegations = append(t.delegations, trace)
	t.latency.SubAgentMs = addMs(t.latency.SubAgentMs, trace.DurationMs)
	t.Event("delegation_completed", map[string]any{
		"taskId": trace.TaskID, "status": trace.Status, "evidenceCount": trace.EvidenceCount,
	})
}

// RecordEvidenceIDs 登记证据 id。
func (t *TraceCollector) RecordEvidenceIDs(ids []string) {
	for _, id := range ids {
		t.evidenceIDs[id] = true
	}
}

// RecordRetrievalDiagnostics 检索诊断只进 Trace 不进上下文。
func (t *TraceCollector) RecordRetrievalDiagnostics(payload map[string]any) {
	t.Event("retrieval_diagnostics", payload)
	if ms, ok := asFloat(payload["retrievalMs"]); ok {
		t.latency.RetrievalMs = addMs(t.latency.RetrievalMs, int64(ms))
	}
	if ms, ok := asFloat(payload["rerankMs"]); ok {
		t.latency.RerankMs = addMs(t.latency.RerankMs, int64(ms))
	}
}

// AddTokenUsage 累加 token。
func (t *TraceCollector) AddTokenUsage(input, output int64) {
	t.tokenUsage.Input += input
	t.tokenUsage.Output += output
	t.tokenUsage.Total += input + output
}

// AddLlmLatency 累加 LLM 时延。
func (t *TraceCollector) AddLlmLatency(ms int64) {
	t.latency.LlmMs = addMs(t.latency.LlmMs, ms)
}

// MarkFirstToken 标记首 token。
func (t *TraceCollector) MarkFirstToken() {
	if t.latency.TtftMs == nil {
		v := nowMs() - t.startedAt
		t.latency.TtftMs = &v
	}
}

// Finish 收尾。
func (t *TraceCollector) Finish(stopReason AgentStopReason) {
	t.stopReason = stopReason
	t.completedAt = nowMs()
	total := t.completedAt - t.startedAt
	t.latency.TotalMs = &total
	payload := map[string]any{"totalMs": total}
	if stopReason != "" {
		payload["stopReason"] = stopReason
	}
	t.Event("stop", payload)
}

// Build 输出最终 trace。
func (t *TraceCollector) Build() *AgentTrace {
	ids := make([]string, 0, len(t.evidenceIDs))
	for id := range t.evidenceIDs {
		ids = append(ids, id)
	}
	out := &AgentTrace{
		RunID:          t.runID,
		ConversationID: t.conversationID,
		UserID:         t.userID,
		Model:          t.model,
		RoutingHint:    t.routingHint,
		Complexity:     t.complexity,
		Steps:          t.events,
		ToolCalls:      t.toolCalls,
		SkillLoads:     t.skillLoads,
		Delegations:    t.delegations,
		EvidenceIDs:    ids,
		TokenUsage:     t.tokenUsage,
		Latency:        t.latency,
		StartedAt:      t.startedAt,
		StopReason:     t.stopReason,
	}
	if t.completedAt > 0 {
		out.CompletedAt = t.completedAt
		out.TotalLatencyMs = t.completedAt - t.startedAt
	}
	return out
}

func addMs(current *int64, delta int64) *int64 {
	var base int64
	if current != nil {
		base = *current
	}
	base += delta
	return &base
}

var sensitiveKeyPattern = regexp.MustCompile(`(?i)(password|secret|token|api[-_]?key|credential|authorization|cookie|access[-_]?key|private[-_]?key)`)

const (
	maxRedactString = 4000
	maxRedactArray  = 50
	maxRedactDepth  = 6
)

// Redact 敏感 key 一律打码；长文本与长数组截断，避免 trace 表被单条撑爆。
func Redact(value any) any { return redact(value) }

func redact(value any) any { return redactDepth(value, 0) }

func redactDepth(value any, depth int) any {
	if value == nil {
		return nil
	}
	if depth >= maxRedactDepth {
		return "[truncated:depth]"
	}
	switch v := value.(type) {
	case string:
		r := []rune(v)
		if len(r) > maxRedactString {
			return string(r[:maxRedactString]) + "…[+" + itoa(len(r)-maxRedactString) + "]"
		}
		return v
	case json.RawMessage:
		var generic any
		if json.Unmarshal(v, &generic) == nil {
			return redactDepth(generic, depth)
		}
		return string(v)
	case []any:
		out := make([]any, 0, len(v))
		for i, item := range v {
			if i >= maxRedactArray {
				out = append(out, "[+"+itoa(len(v)-maxRedactArray)+" more]")
				break
			}
			out = append(out, redactDepth(item, depth+1))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			if sensitiveKeyPattern.MatchString(key) {
				out[key] = "[redacted]"
				continue
			}
			out[key] = redactDepth(item, depth+1)
		}
		return out
	default:
		raw, err := json.Marshal(value)
		if err != nil {
			return strings.TrimSpace(strings.ReplaceAll(strings.TrimSpace(""), "", ""))
		}
		var generic any
		if json.Unmarshal(raw, &generic) == nil && !isPrimitive(generic) {
			return redactDepth(generic, depth)
		}
		return value
	}
}

func isPrimitive(v any) bool {
	switch v.(type) {
	case string, float64, bool, nil:
		return true
	}
	return false
}

func redactMap(payload map[string]any) any { return redactDepth(payload, 0) }
