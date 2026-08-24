package runtime

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ===== 观察存储（对照 observation.ts）=====

// ObservationStore 原始 Tool Result 只进 Trace；进 LLM Context 的是紧凑 observation。
type ObservationStore struct {
	items []AgentObservation
	index map[string]string
}

// NewObservationStore 构造。
func NewObservationStore() *ObservationStore {
	return &ObservationStore{index: map[string]string{}}
}

func observationFingerprint(o AgentObservation) string {
	return o.Type + ":" + o.Source + ":" + StableHash(map[string]any{
		"summary": o.Summary,
		"data":    json.RawMessage(o.Data),
		"isError": o.IsError,
	})
}

// Add 添加观察（指纹去重：同一观察再次出现只合并证据 id）。
func (s *ObservationStore) Add(observation AgentObservation) AgentObservation {
	fingerprint := observationFingerprint(observation)
	if existingID, ok := s.index[fingerprint]; ok {
		for i := range s.items {
			if s.items[i].ID != existingID {
				continue
			}
			existing := &s.items[i]
			for _, id := range observation.EvidenceIDs {
				if !containsString(existing.EvidenceIDs, id) {
					existing.EvidenceIDs = append(existing.EvidenceIDs, id)
				}
			}
			return *existing
		}
	}
	s.items = append(s.items, observation)
	s.index[fingerprint] = observation.ID
	return observation
}

// All 全部观察。
func (s *ObservationStore) All() []AgentObservation { return s.items }

// Recent 最近 N 条。
func (s *ObservationStore) Recent(n int) []AgentObservation {
	if n >= len(s.items) {
		return s.items
	}
	return s.items[len(s.items)-n:]
}

// Size 数量。
func (s *ObservationStore) Size() int { return len(s.items) }

// CreateObservation 构造观察。
func CreateObservation(typ, source, summary string, data json.RawMessage, evidenceIDs, suggestedActions []string, isError bool, now int64) AgentObservation {
	if evidenceIDs == nil {
		evidenceIDs = []string{}
	}
	o := AgentObservation{
		ID:               NewID("obs"),
		Type:             typ,
		Source:           source,
		Summary:          summary,
		Data:             data,
		EvidenceIDs:      evidenceIDs,
		SuggestedActions: suggestedActions,
		IsError:          isError,
		CreatedAt:        now,
	}
	if now <= 0 {
		o.CreatedAt = nowMs()
	}
	return o
}

// ErrorObservation 工具错误 → 观察：给模型可执行的下一步，而不是丢一个异常。
func ErrorObservation(toolID string, errShape AgentToolErrorShape) AgentObservation {
	return CreateObservation(
		"tool_error",
		toolID,
		toolID+" 执行失败："+errShape.Message,
		mustJSON(map[string]any{"code": errShape.Code}),
		nil,
		suggestedActionsForError(errShape),
		true,
		nowMs(),
	)
}

func suggestedActionsForError(errShape AgentToolErrorShape) []string {
	switch errShape.Code {
	case CodeToolTimeout:
		return []string{"retry", "use_alternative_source"}
	case CodeValidationError:
		return []string{"fix_arguments"}
	case CodePermissionDenied:
		return []string{"explain_permission_limit"}
	case CodeSkillNotFound:
		return []string{"list_available_skills"}
	case CodeRetrievalFailed:
		return []string{"rewrite_query", "use_alternative_source"}
	case CodeSubagentFailed:
		return []string{"handle_inline", "reduce_scope"}
	default:
		if errShape.Retryable {
			return []string{"retry"}
		}
		return []string{"use_alternative_source"}
	}
}

// DefaultSummarize 工具没有自定义 normalizer 时的兜底摘要。
func DefaultSummarize(toolID string, output any) string {
	if output == nil {
		return toolID + " 返回空结果"
	}
	switch v := output.(type) {
	case string:
		text := trimSpace(v)
		runes := len([]rune(text))
		if runes > 200 {
			r := []rune(text)
			return toolID + " 返回文本（" + itoa(runes) + " 字）：" + string(r[:200]) + "…"
		}
		return toolID + "：" + text
	case []any:
		return toolID + " 返回 " + itoa(len(v)) + " 条结果"
	case map[string]any:
		for _, key := range []string{"hits", "items", "results", "articles", "nodes", "rows"} {
			if arr, ok := v[key].([]any); ok {
				if len(arr) == 0 {
					return toolID + " 未找到结果"
				}
				return toolID + " 找到 " + itoa(len(arr)) + " 条结果"
			}
		}
		if sv, ok := v["summary"].(string); ok && trimSpace(sv) != "" {
			return truncateRunes(trimSpace(sv), 400)
		}
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if len(keys) > 8 {
			keys = keys[:8]
		}
		return toolID + " 返回结构化结果（字段：" + strings.Join(keys, ", ") + "）"
	default:
		raw, _ := jsonMarshal(output)
		return toolID + " 返回 " + truncateRunes(string(raw), 200)
	}
}

// RenderObservation observation 渲染进 prompt 的紧凑一行。
func RenderObservation(o AgentObservation) string {
	flag := "✓"
	if o.IsError {
		flag = "✗"
	}
	actions := ""
	if len(o.SuggestedActions) > 0 {
		actions = "（建议：" + strings.Join(o.SuggestedActions, " / ") + "）"
	}
	refs := ""
	if len(o.EvidenceIDs) > 0 {
		refs = " [证据 " + itoa(len(o.EvidenceIDs)) + " 条]"
	}
	return flag + " " + o.Source + "：" + o.Summary + refs + actions
}

// ===== 证据存储（对照 evidence.ts）=====

// EvidenceInput 不带 id/createdAt 的证据输入。
type EvidenceInput = AgentEvidence

// EvidenceStore 证据存储与去重。
//
// 去重键按优先级取第一个可用：sourceId → nodeKey → canonical URL → 内容哈希 → 归一化标题。
type EvidenceStore struct {
	items []AgentEvidence
	index map[string]string
}

// NewEvidenceStore 构造。
func NewEvidenceStore() *EvidenceStore {
	return &EvidenceStore{index: map[string]string{}, items: []AgentEvidence{}}
}

func dedupKeys(input EvidenceInput) []string {
	if sid := trimSpace(input.SourceID); sid != "" {
		return []string{"sid:" + string(input.Source) + ":" + sid}
	}
	if nodeKey, ok := input.Metadata["nodeKey"].(string); ok && trimSpace(nodeKey) != "" {
		return []string{"node:" + string(input.Source) + ":" + trimSpace(nodeKey)}
	}
	if input.URL != "" {
		return []string{"url:" + CanonicalURL(input.URL)}
	}
	content := trimSpace(input.Content)
	if content != "" {
		return []string{"hash:" + string(input.Source) + ":" + ContentHash(content)}
	}
	title := trimSpace(input.Title)
	if title != "" {
		return []string{"title:" + string(input.Source) + ":" + NormalizeTitle(title)}
	}
	return nil
}

// Add 添加证据（去重合并）。
func (s *EvidenceStore) Add(input EvidenceInput) *AgentEvidence {
	keys := dedupKeys(input)
	for _, key := range keys {
		existingID, ok := s.index[key]
		if !ok {
			continue
		}
		for i := range s.items {
			if s.items[i].ID == existingID {
				mergeEvidence(&s.items[i], input)
				for _, k := range keys {
					s.index[k] = s.items[i].ID
				}
				return &s.items[i]
			}
		}
	}

	evidence := input
	evidence.ID = NewID("ev")
	evidence.CreatedAt = nowMs()
	if evidence.Freshness == nil {
		if publishedAt, ok := evidence.Metadata["publishedAt"].(string); ok && publishedAt != "" {
			if f := FreshnessFromDate(publishedAt); f != nil {
				evidence.Freshness = f
			}
		}
	}
	if _, ok := evidence.Metadata["sourceQuality"]; !ok {
		if evidence.Metadata == nil {
			evidence.Metadata = map[string]any{}
		}
		evidence.Metadata["sourceQuality"] = ScoreSourceQuality(input)
	}
	if evidence.Metadata == nil {
		evidence.Metadata = nil
	}
	s.items = append(s.items, evidence)
	for _, key := range keys {
		s.index[key] = evidence.ID
	}
	return &s.items[len(s.items)-1]
}

// AddMany 批量添加。
func (s *EvidenceStore) AddMany(inputs []EvidenceInput) []*AgentEvidence {
	out := make([]*AgentEvidence, 0, len(inputs))
	for _, input := range inputs {
		out = append(out, s.Add(input))
	}
	return out
}

// Merge 合并子代理返回的证据（重新分配 id 以免跨 run 冲突）。
func (s *EvidenceStore) Merge(evidence []AgentEvidence) []*AgentEvidence {
	out := make([]*AgentEvidence, 0, len(evidence))
	for _, item := range evidence {
		item.ID = ""
		item.CreatedAt = 0
		out = append(out, s.Add(item))
	}
	return out
}

// All 全部证据。
func (s *EvidenceStore) All() []AgentEvidence { return s.items }

// Get 按 id 取。
func (s *EvidenceStore) Get(id string) *AgentEvidence {
	for i := range s.items {
		if s.items[i].ID == id {
			return &s.items[i]
		}
	}
	return nil
}

// Size 数量。
func (s *EvidenceStore) Size() int { return len(s.items) }

// CitationIndex 一次 Run 内稳定的引用编号（1-based）。
func (s *EvidenceStore) CitationIndex(id string) int {
	for i := range s.items {
		if s.items[i].ID == id {
			return i + 1
		}
	}
	return 0
}

// TopN 按综合分排序取前 N。
func (s *EvidenceStore) TopN(n int) []AgentEvidence {
	pool := append([]AgentEvidence{}, s.items...)
	sort.SliceStable(pool, func(i, j int) bool {
		return ScoreEvidence(pool[i]) > ScoreEvidence(pool[j])
	})
	if len(pool) > n {
		pool = pool[:n]
	}
	return pool
}

// ScoreEvidence 综合排序分：相关性为主，可信度与新鲜度次之，来源质量兜底。
func ScoreEvidence(evidence AgentEvidence) float64 {
	relevance := orDefault(evidence.Relevance, 0.5)
	confidence := orDefault(evidence.Confidence, 0.5)
	freshness := orDefault(evidence.Freshness, 0.5)
	quality := 0.5
	if q, ok := asFloat(evidence.Metadata["sourceQuality"]); ok {
		quality = q
	}
	return relevance*0.55 + confidence*0.2 + quality*0.15 + freshness*0.1
}

func mergeEvidence(existing *AgentEvidence, incoming EvidenceInput) {
	if existing.Title == "" && incoming.Title != "" {
		existing.Title = incoming.Title
	}
	if existing.URL == "" && incoming.URL != "" {
		existing.URL = incoming.URL
	}
	if existing.SourceID == "" && incoming.SourceID != "" {
		existing.SourceID = incoming.SourceID
	}
	if len([]rune(incoming.Content)) > len([]rune(existing.Content)) {
		existing.Content = incoming.Content
	}
	if incoming.FullRead {
		existing.FullRead = true
	}
	if incoming.Relevance != nil {
		max := incoming.Relevance
		if existing.Relevance != nil && *existing.Relevance > *max {
			max = existing.Relevance
		}
		existing.Relevance = max
	}
	if incoming.Confidence != nil {
		max := incoming.Confidence
		if existing.Confidence != nil && *existing.Confidence > *max {
			max = existing.Confidence
		}
		existing.Confidence = max
	}
	if incoming.Freshness != nil {
		max := incoming.Freshness
		if existing.Freshness != nil && *existing.Freshness > *max {
			max = existing.Freshness
		}
		existing.Freshness = max
	}
	if incoming.Metadata != nil {
		if existing.Metadata == nil {
			existing.Metadata = map[string]any{}
		}
		for k, v := range incoming.Metadata {
			existing.Metadata[k] = v
		}
	}
}

var wwwPattern = regexp.MustCompile(`^www\.`)
var trackParamPattern = regexp.MustCompile(`^(utm_|ref$|referrer$|fbclid$|gclid$|spm$|from$)`)

// CanonicalURL URL 归一：去协议差异、去 www、去末尾斜杠、去跟踪参数、去 hash。
func CanonicalURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return strings.TrimRight(strings.ToLower(strings.TrimSpace(raw)), "/")
	}
	u.Fragment = ""
	u.Scheme = "https"
	host := strings.ToLower(u.Hostname())
	host = wwwPattern.ReplaceAllString(host, "")
	drop := []string{}
	for key := range u.Query() {
		if trackParamPattern.MatchString(strings.ToLower(key)) {
			drop = append(drop, key)
		}
	}
	q := u.Query()
	for _, key := range drop {
		q.Del(key)
	}
	u.RawQuery = q.Encode()
	path := strings.TrimRight(u.Path, "/")
	if path == "" {
		path = "/"
	}
	result := host + path
	if enc := u.RawQuery; enc != "" {
		result += "?" + enc
	}
	return result
}

var whitespacePattern = regexp.MustCompile(`\s+`)

// ContentHash 折叠空白与全角标点后取内容哈希，避免排版差异导致重复。
func ContentHash(content string) string {
	normalized := whitespacePattern.ReplaceAllString(content, " ")
	replacer := strings.NewReplacer("，", ",", "。", ".", "；", ";", "：", ":", "！", "!", "？", "?")
	normalized = replacer.Replace(normalized)
	normalized = strings.ToLower(strings.TrimSpace(normalized))
	sum := sha1.Sum([]byte(normalized))
	return hex.EncodeToString(sum[:])[:20]
}

var titleNoisePattern = regexp.MustCompile(`[-_—–|·:：、,，.。()（）\[\]【】"'“”‘’]`)

// NormalizeTitle 标题归一化。
func NormalizeTitle(title string) string {
	t := strings.ToLower(title)
	t = whitespacePattern.ReplaceAllString(t, "")
	t = titleNoisePattern.ReplaceAllString(t, "")
	return trimSpace(t)
}

// ScoreSourceQuality 来源质量规则打分：内部知识库/图谱高可信；官方域名高于普通博客。
func ScoreSourceQuality(input EvidenceInput) float64 {
	switch input.Source {
	case EvidenceKnowledge, EvidenceGraph:
		return 0.85
	case EvidenceMemory:
		return 0.7
	case EvidenceSubagent, EvidenceTool:
		return 0.6
	case EvidenceWeb:
		host := ""
		if input.URL != "" {
			parts := strings.SplitN(CanonicalURL(input.URL), "/", 2)
			host = parts[0]
		}
		if host == "" {
			return 0.4
		}
		if govEduPattern.MatchString(host) {
			return 0.95
		}
		if docsHostPattern.MatchString(host) {
			return 0.9
		}
		if academicPattern.MatchString(host) {
			return 0.9
		}
		if forgePattern.MatchString(host) {
			return 0.75
		}
		if blogFarmPattern.MatchString(host) {
			return 0.45
		}
		return 0.6
	default:
		return 0.5
	}
}

var (
	govEduPattern   = regexp.MustCompile(`(^|\.)(gov|edu)(\.|$)`)
	docsHostPattern = regexp.MustCompile(`^(docs?|developer|developers|api|learn|support)\.`)
	academicPattern = regexp.MustCompile(`\b(arxiv|ieee|acm|nature|science)\b`)
	forgePattern    = regexp.MustCompile(`(^|\.)(github|gitlab)\.(com|io)$`)
	blogFarmPattern = regexp.MustCompile(`(medium|zhihu|csdn|jianshu|blogspot|wordpress|substack)\.`)
)

// FreshnessFromDate 新鲜度：半衰期 365 天的指数衰减，映射到 0~1。
func FreshnessFromDate(value string) *float64 {
	var t int64
	for _, layout := range []string{time.RFC3339, "2006-01-02", "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			t = parsed.UnixMilli()
			break
		}
	}
	if t == 0 {
		return nil
	}
	days := float64(nowMs()-t) / 86400000
	if days < 0 {
		days = 0
	}
	v := round4(pow05(days / 365))
	return &v
}

func pow05(x float64) float64 {
	// 0.5^x = exp(-x·ln2)
	return expFloat(-x * 0.6931471805599453)
}

func expFloat(x float64) float64 {
	const terms = 24
	sum := 1.0
	pow := 1.0
	fact := 1.0
	for i := 1; i <= terms; i++ {
		pow *= x
		fact *= float64(i)
		sum += pow / fact
	}
	return sum
}

func round4(v float64) float64 { return float64(int64(v*10000+0.5)) / 10000 }

func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}

func orDefault(v *float64, def float64) float64 {
	if v == nil {
		return def
	}
	return *v
}

func asFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func itoa(n int) string { return strconv.Itoa(n) }

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return raw
}

func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}
