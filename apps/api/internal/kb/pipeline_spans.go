package kb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentspan"
)

// Span 类型。词汇对齐可观测性系统，前端按 kind 决定行的渲染方式：
//   - root       一次解析尝试的根，用来算总耗时
//   - stage      主流程阶段，时间线上的六段
//   - subspan    阶段内的子任务
//   - generation 包了一次模型调用的子任务
const (
	SpanKindRoot       = "root"
	SpanKindStage      = "stage"
	SpanKindSubSpan    = "subspan"
	SpanKindGeneration = "generation"
)

// Span 状态。failed 是这一段自己出错，cancelled 是上游失败后它根本没机会跑，
// 分开是为了让时间线能显示"谁炸的"和"被谁连累"。
const (
	SpanStatusPending   = "pending"
	SpanStatusRunning   = "running"
	SpanStatusDone      = "done"
	SpanStatusFailed    = "failed"
	SpanStatusSkipped   = "skipped"
	SpanStatusCancelled = "cancelled"
)

// 主流程阶段名。这是一个封闭集合，前端固定渲染六段；
// 子任务名是自由的（如 multimodal.page[3]），不走这个列表。
const (
	StageExtract    = "extract"
	StageChunking   = "chunking"
	StageEmbedding  = "embedding"
	StageMultimodal = "multimodal"
	StagePostFinish = "postprocess"
	StageWiki       = "wiki"
)

// AllPipelineStages 是阶段的规范顺序。API 层用它补齐没跑到的阶段，
// 让时间线在解析刚开始时也能显示完整六段。
var AllPipelineStages = []string{
	StageExtract,
	StageChunking,
	StageEmbedding,
	StageMultimodal,
	StagePostFinish,
	StageWiki,
}

// stageDependencies 声明阶段之间的依赖，用于某段失败时把下游标记为 cancelled。
// 多模态不依赖向量化：两者都只依赖分块，各跑各的；后处理等两者都结束。
var stageDependencies = map[string][]string{
	StageExtract:    nil,
	StageChunking:   {StageExtract},
	StageEmbedding:  {StageChunking},
	StageMultimodal: {StageChunking},
	StagePostFinish: {StageEmbedding, StageMultimodal},
	StageWiki:       {StagePostFinish},
}

// pipelineSpan 是流水线执行时持有的句柄，End/Fail/Skip 靠它写回，不用再查库。
type pipelineSpan struct {
	documentID int64
	userID     int64
	attempt    int
	spanID     string
	name       string
	kind       string
	parent     *pipelineSpan
	startedAt  time.Time
}

// spanTracker 记录一次解析的 span 树。
//
// 所有写入都是尽力而为：写库失败只记日志、不打断解析。文档自身的 status
// 才是解析是否成功的权威来源，span 只是给人看的过程记录。
type spanTracker struct {
	svc        *Service
	userID     int64
	documentID int64
	attempt    int
	root       *pipelineSpan

	mu     sync.Mutex
	stages map[string]*pipelineSpan
}

func newSpanID() string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(buf)
}

// spanJSON 把结构化的入参/出参序列化成 jsonb 字符串，失败时退化为 nil。
func spanJSON(payload map[string]any) *string {
	if len(payload) == 0 {
		return nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	value := string(raw)
	return &value
}

// newSpanTracker 开启一次新的尝试：写入 root span，后续所有阶段都挂在它下面。
func (s *Service) newSpanTracker(ctx context.Context, userID, documentID int64, attempt int, input map[string]any) *spanTracker {
	tracker := &spanTracker{
		svc:        s,
		userID:     userID,
		documentID: documentID,
		attempt:    attempt,
		stages:     map[string]*pipelineSpan{},
	}
	tracker.root = &pipelineSpan{
		documentID: documentID, userID: userID, attempt: attempt,
		spanID: newSpanID(), name: "document_processing", kind: SpanKindRoot, startedAt: time.Now().UTC(),
	}
	tracker.write(ctx, tracker.root, SpanStatusRunning, spanJSON(input), nil, "", "")
	return tracker
}

// write 落一行 span。同一 (document_id, attempt, span_id) 采用 upsert 语义：
// 先尝试更新，没有命中再插入。
func (t *spanTracker) write(
	ctx context.Context, span *pipelineSpan, status string,
	input, output *string, errorCode, errorMessage string,
) {
	if t == nil || t.svc == nil || t.svc.client == nil {
		return
	}
	now := time.Now().UTC()
	finished := status != SpanStatusRunning && status != SpanStatusPending
	duration := int64(0)
	if finished && !span.startedAt.IsZero() {
		duration = now.Sub(span.startedAt).Milliseconds()
	}

	existing, err := t.svc.client.KBDocumentSpan.Query().Where(
		kbdocumentspan.DocumentIDEQ(span.documentID),
		kbdocumentspan.AttemptEQ(span.attempt),
		kbdocumentspan.SpanIDEQ(span.spanID),
	).Only(ctx)
	if err == nil {
		update := existing.Update().SetStatus(status)
		if finished {
			update.SetFinishedAt(now).SetDurationMs(duration)
		}
		if input != nil {
			update.SetInput(*input)
		}
		if output != nil {
			update.SetOutput(*output)
		}
		if errorCode != "" {
			update.SetErrorCode(errorCode)
		}
		if errorMessage != "" {
			update.SetErrorMessage(truncateSpanText(errorMessage, 2000))
		}
		if _, saveErr := update.Save(ctx); saveErr != nil {
			t.logSpanFailure("更新解析 span 失败", saveErr)
		}
		return
	}
	if !ent.IsNotFound(err) {
		t.logSpanFailure("读取解析 span 失败", err)
		return
	}

	builder := t.svc.client.KBDocumentSpan.Create().
		SetUserID(span.userID).SetDocumentID(span.documentID).SetAttempt(span.attempt).
		SetSpanID(span.spanID).SetName(span.name).SetKind(span.kind).SetStatus(status)
	if span.parent != nil {
		builder.SetParentSpanID(span.parent.spanID)
	}
	if !span.startedAt.IsZero() {
		builder.SetStartedAt(span.startedAt)
	}
	if finished {
		builder.SetFinishedAt(now).SetDurationMs(duration)
	}
	if input != nil {
		builder.SetInput(*input)
	}
	if output != nil {
		builder.SetOutput(*output)
	}
	if errorCode != "" {
		builder.SetErrorCode(errorCode)
	}
	if errorMessage != "" {
		builder.SetErrorMessage(truncateSpanText(errorMessage, 2000))
	}
	if _, saveErr := builder.Save(ctx); saveErr != nil {
		t.logSpanFailure("写入解析 span 失败", saveErr)
	}
}

func (t *spanTracker) logSpanFailure(message string, err error) {
	if t.svc != nil && t.svc.log != nil {
		t.svc.log.Debug(message, zap.Error(err))
	}
}

// BeginStage 开启一个主流程阶段。同名阶段重复开启会复用同一 span_id，
// 这样重试不会在时间线上分裂成两段。
func (t *spanTracker) BeginStage(ctx context.Context, stage string, input map[string]any) *pipelineSpan {
	if t == nil {
		return nil
	}
	t.mu.Lock()
	span, ok := t.stages[stage]
	if !ok {
		span = &pipelineSpan{
			documentID: t.documentID, userID: t.userID, attempt: t.attempt,
			spanID: newSpanID(), name: stage, kind: SpanKindStage, parent: t.root,
		}
		t.stages[stage] = span
	}
	span.startedAt = time.Now().UTC()
	t.mu.Unlock()

	t.write(ctx, span, SpanStatusRunning, spanJSON(input), nil, "", "")
	return span
}

// BeginSubSpan 在某个阶段下开启子任务。kind 传 SpanKindGeneration 表示里面有模型调用。
func (t *spanTracker) BeginSubSpan(ctx context.Context, parent *pipelineSpan, name, kind string, input map[string]any) *pipelineSpan {
	if t == nil || parent == nil {
		return nil
	}
	span := &pipelineSpan{
		documentID: t.documentID, userID: t.userID, attempt: t.attempt,
		spanID: newSpanID(), name: name, kind: kind, parent: parent, startedAt: time.Now().UTC(),
	}
	t.write(ctx, span, SpanStatusRunning, spanJSON(input), nil, "", "")
	return span
}

func (t *spanTracker) EndSpan(ctx context.Context, span *pipelineSpan, output map[string]any) {
	if t == nil || span == nil {
		return
	}
	t.write(ctx, span, SpanStatusDone, nil, spanJSON(output), "", "")
}

func (t *spanTracker) SkipSpan(ctx context.Context, span *pipelineSpan, reason string) {
	if t == nil || span == nil {
		return
	}
	t.write(ctx, span, SpanStatusSkipped, nil, spanJSON(map[string]any{"reason": reason}), "", "")
}

// FailSpan 只标记这一段失败。是否连累下游由调用方决定：
// 向量化、多模态这类阶段失败后流水线还会继续跑，不该把后处理标成 cancelled。
func (t *spanTracker) FailSpan(ctx context.Context, span *pipelineSpan, code string, err error) {
	if t == nil || span == nil {
		return
	}
	message := ""
	if err != nil {
		message = err.Error()
	}
	t.write(ctx, span, SpanStatusFailed, nil, nil, code, message)
}

// CancelDownstream 把依赖 stage 的所有下游阶段（含间接依赖）置为 cancelled。
// 用于终止整次解析的致命失败，否则时间线会留下几个永远转圈的 pending。
func (t *spanTracker) CancelDownstream(ctx context.Context, stage, reason string) {
	for _, name := range stagesDependingOn(stage) {
		t.mu.Lock()
		span, ok := t.stages[name]
		if !ok {
			span = &pipelineSpan{
				documentID: t.documentID, userID: t.userID, attempt: t.attempt,
				spanID: newSpanID(), name: name, kind: SpanKindStage, parent: t.root,
			}
			t.stages[name] = span
		}
		t.mu.Unlock()
		t.write(ctx, span, SpanStatusCancelled, nil, spanJSON(map[string]any{"reason": reason}), "", "")
	}
}

// stagesDependingOn 反向遍历依赖表，返回 stage 的全部下游（传递闭包）。
func stagesDependingOn(stage string) []string {
	result := make([]string, 0, len(AllPipelineStages))
	seen := map[string]struct{}{stage: {}}
	frontier := []string{stage}
	for len(frontier) > 0 {
		current := frontier[0]
		frontier = frontier[1:]
		for _, candidate := range AllPipelineStages {
			if _, done := seen[candidate]; done {
				continue
			}
			for _, upstream := range stageDependencies[candidate] {
				if upstream != current {
					continue
				}
				seen[candidate] = struct{}{}
				result = append(result, candidate)
				frontier = append(frontier, candidate)
				break
			}
		}
	}
	return result
}

// FinishRoot 关闭根 span，把整次尝试的结论写下来。
func (t *spanTracker) FinishRoot(ctx context.Context, failed bool, code string, err error, output map[string]any) {
	if t == nil || t.root == nil {
		return
	}
	if failed {
		message := ""
		if err != nil {
			message = err.Error()
		}
		t.write(ctx, t.root, SpanStatusFailed, nil, spanJSON(output), code, message)
		return
	}
	t.write(ctx, t.root, SpanStatusDone, nil, spanJSON(output), "", "")
}

func truncateSpanText(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// ---------------------------------------------------------------------------
// 读取侧：把扁平的 span 行装配成树，交给前端画时间线。
// ---------------------------------------------------------------------------

// SpanNode 是给前端的树节点。
type SpanNode struct {
	SpanID       string      `json:"spanId"`
	ParentSpanID string      `json:"parentSpanId,omitempty"`
	Name         string      `json:"name"`
	Kind         string      `json:"kind"`
	Status       string      `json:"status"`
	Input        any         `json:"input,omitempty"`
	Output       any         `json:"output,omitempty"`
	ErrorCode    string      `json:"errorCode,omitempty"`
	ErrorMessage string      `json:"errorMessage,omitempty"`
	StartedAt    *string     `json:"startedAt,omitempty"`
	FinishedAt   *string     `json:"finishedAt,omitempty"`
	DurationMs   int64       `json:"durationMs"`
	Placeholder  bool        `json:"placeholder,omitempty"`
	Children     []*SpanNode `json:"children,omitempty"`
}

// buildSpanTree 把某次尝试的 span 行拼成树，并把没跑到的主流程阶段补成占位节点，
// 保证时间线任何时刻都渲染六段。返回树根、当前正在跑的阶段名、最近一次失败。
func buildSpanTree(rows []*ent.KBDocumentSpan, documentStatus string) (*SpanNode, string, *SpanNode) {
	nodes := make(map[string]*SpanNode, len(rows))
	var root *SpanNode
	var lastFailure *SpanNode
	currentStage := ""

	for _, row := range rows {
		node := spanRowToNode(row)
		nodes[node.SpanID] = node
		if node.Kind == SpanKindRoot {
			root = node
		}
		if node.Status == SpanStatusFailed {
			if lastFailure == nil || node.Kind == SpanKindStage {
				lastFailure = node
			}
		}
		if node.Kind == SpanKindStage && node.Status == SpanStatusRunning {
			currentStage = node.Name
		}
	}

	if root == nil {
		// 还没开始跑（或历史文档没有 span）：合成一个根，让前端有统一的挂载点。
		root = &SpanNode{
			SpanID: "virtual-root", Name: "document_processing", Kind: SpanKindRoot,
			Status: placeholderStatus(documentStatus), Placeholder: true,
		}
	}

	for _, node := range nodes {
		if node == root {
			continue
		}
		parent := nodes[node.ParentSpanID]
		if parent == nil {
			parent = root
		}
		parent.Children = append(parent.Children, node)
	}

	// 补齐缺失的主流程阶段，并按规范顺序排列 root 的直接子节点。
	stageByName := map[string]*SpanNode{}
	for _, child := range root.Children {
		if child.Kind == SpanKindStage {
			stageByName[child.Name] = child
		}
	}
	for _, name := range AllPipelineStages {
		if _, ok := stageByName[name]; ok {
			continue
		}
		placeholder := &SpanNode{
			SpanID: "virtual-" + name, ParentSpanID: root.SpanID, Name: name, Kind: SpanKindStage,
			Status: placeholderStatus(documentStatus), Placeholder: true,
		}
		stageByName[name] = placeholder
		root.Children = append(root.Children, placeholder)
	}
	stageOrder := map[string]int{}
	for index, name := range AllPipelineStages {
		stageOrder[name] = index
	}
	sort.SliceStable(root.Children, func(i, j int) bool {
		return stageOrder[root.Children[i].Name] < stageOrder[root.Children[j].Name]
	})
	for _, child := range root.Children {
		sortSpanChildren(child)
	}
	return root, currentStage, lastFailure
}

// sortSpanChildren 让子任务按开始时间排列；没有开始时间的排在后面。
func sortSpanChildren(node *SpanNode) {
	sort.SliceStable(node.Children, func(i, j int) bool {
		left, right := node.Children[i].StartedAt, node.Children[j].StartedAt
		if left == nil {
			return false
		}
		if right == nil {
			return true
		}
		return *left < *right
	})
	for _, child := range node.Children {
		sortSpanChildren(child)
	}
}

// placeholderStatus 用文档自身的状态推断占位阶段该显示成什么，
// 否则历史文档会永远显示"六段都在等待"。
func placeholderStatus(documentStatus string) string {
	switch documentStatus {
	case "ready":
		return SpanStatusDone
	case "failed":
		return SpanStatusFailed
	default:
		return SpanStatusPending
	}
}

func spanRowToNode(row *ent.KBDocumentSpan) *SpanNode {
	node := &SpanNode{
		SpanID: row.SpanID, Name: row.Name, Kind: row.Kind, Status: row.Status,
		DurationMs: row.DurationMs,
	}
	if row.ParentSpanID != nil {
		node.ParentSpanID = *row.ParentSpanID
	}
	if row.ErrorCode != nil {
		node.ErrorCode = *row.ErrorCode
	}
	if row.ErrorMessage != nil {
		node.ErrorMessage = *row.ErrorMessage
	}
	node.StartedAt = formatTimePtr(row.StartedAt)
	node.FinishedAt = formatTimePtr(row.FinishedAt)
	node.Input = decodeSpanJSON(row.Input)
	node.Output = decodeSpanJSON(row.Output)
	return node
}

func decodeSpanJSON(raw *string) any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var out any
	if err := json.Unmarshal([]byte(*raw), &out); err != nil {
		return nil
	}
	return out
}
