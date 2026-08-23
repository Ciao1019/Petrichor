// aigen.go 对照 handlers.ts：article/summary/generate 与 article/mindmap/generate。
// 提示词与输出归一化逻辑与 internal/kb/mindmap-summary.go 同源（对照同一组 TS 函数），
// 走 kb.ChatInvoker 注入点；ChatRequest 暂无 modelRefId 字段，模型选择沿用用户默认配置。
package agentapi

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/kb"
)

const (
	mindmapMaxModelInputChars = 12000
	summaryMaxModelInputChars = 12000
	summaryMaxChars           = 420
)

func sha256HexText(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

func md5HexText(v string) string {
	sum := md5.Sum([]byte(v))
	return hex.EncodeToString(sum[:])
}

// ===== AI 摘要 =====

var (
	summaryFenceHead = regexp.MustCompile(`(?i)^` + "```" + `(?:markdown|md|text)?\s*`)
	summaryFenceTail = regexp.MustCompile(`(?i)` + "```" + `$`)
	summaryHeading   = regexp.MustCompile(`^#{1,6}\s*摘要\s*`)
	summaryLabel     = regexp.MustCompile(`(?i)^(文章)?(AI\s*)?摘要[:：]\s*`)
	spaceCollapse    = regexp.MustCompile(`\s+`)
)

func normalizeSummaryOutput(raw string) (string, error) {
	normalized := strings.TrimSpace(summaryFenceHead.ReplaceAllString(raw, ""))
	normalized = strings.TrimSpace(summaryLabel.ReplaceAllString(normalized, ""))
	normalized = strings.TrimSpace(summaryHeading.ReplaceAllString(normalized, ""))
	normalized = strings.TrimSpace(summaryFenceTail.ReplaceAllString(normalized, ""))
	normalized = strings.TrimSpace(spaceCollapse.ReplaceAllString(normalized, " "))
	if normalized == "" {
		return "", badReq("模型未返回有效摘要")
	}
	runes := []rune(normalized)
	if len(runes) > summaryMaxChars {
		return strings.TrimRight(string(runes[:summaryMaxChars]), " \t") + "...", nil
	}
	return normalized, nil
}

func buildArticleSummarySystemPrompt() string {
	return strings.Join([]string{
		"你是一个严谨的文章摘要助手。",
		"请根据用户提供的文章标题与 Markdown 正文，生成一段中文摘要。",
		"规则：",
		"- 只输出摘要正文，不要输出标题、解释、项目符号、Markdown 或代码块。",
		"- 摘要控制在 80 到 180 个汉字左右，最多不超过 420 个字符。",
		"- 优先概括文章核心观点、关键结论和阅读价值。",
		"- 不要虚构文章中不存在的事实。",
		"- 如果正文信息很少，也要给出自然的一句话概括。",
	}, "\n")
}

func truncateRunesCopy(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n])
}

func buildArticleSummaryUserMessage(title, contentMd string) string {
	content := contentMd
	if len([]rune(content)) > summaryMaxModelInputChars {
		content = truncateRunesCopy(content, summaryMaxModelInputChars) + "\n\n[内容已截断]"
	}
	return strings.Join([]string{
		"文章标题：" + title,
		"",
		"文章 Markdown 正文：",
		content,
	}, "\n")
}

// AgentGenerateArticleSummary POST /api/agent/article/summary/generate（scope ai:write）。
func AgentGenerateArticleSummary(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "ai:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	forceRebuild := rawBool(raw, "forceRebuild")

	q := dbPool()
	ctx := context.Background()
	row := q.QueryRow(ctx,
		`SELECT id, title, content_md,
		        COALESCE(ai_summary_content_hash, ''), COALESCE(ai_summary, ''),
		        ai_summary_generated_at, updated_at
		 FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
		articleID, actx.UserID)
	var a struct {
		id          int64
		title       string
		contentMd   string
		storedHash  string
		summary     string
		generatedAt *time.Time
		updatedAt   time.Time
	}
	if err := row.Scan(&a.id, &a.title, &a.contentMd, &a.storedHash, &a.summary,
		&a.generatedAt, &a.updatedAt); err != nil {
		if err == pgx.ErrNoRows {
			return nil, notFoundErr("文章不存在")
		}
		return nil, err
	}

	currentHash := md5HexText(a.contentMd)
	if !forceRebuild && strings.TrimSpace(a.summary) != "" &&
		strings.TrimSpace(a.storedHash) == currentHash {
		generatedAt := iso(a.updatedAt)
		if a.generatedAt != nil {
			generatedAt = iso(*a.generatedAt)
		}
		return map[string]any{
			"articleId":   idStr(a.id),
			"fromCache":   true,
			"summary":     strings.TrimSpace(a.summary),
			"generatedAt": generatedAt,
		}, nil
	}

	answer, err := kb.ChatInvoker(ctx, kb.ChatRequest{
		UserID:       actx.UserID,
		SystemPrompt: buildArticleSummarySystemPrompt(),
		Message:      buildArticleSummaryUserMessage(a.title, a.contentMd),
		Op:           "kb.summary",
	})
	if err != nil {
		return nil, err
	}
	summary, nerr := normalizeSummaryOutput(answer)
	if nerr != nil {
		return nil, nerr
	}
	generatedAt := time.Now()
	if _, uerr := q.Exec(ctx,
		`UPDATE petrichor_kb_article SET ai_summary = $1, ai_summary_content_hash = $2,
		 ai_summary_generated_at = $3, updated_at = $3 WHERE id = $4 AND user_id = $5`,
		summary, currentHash, generatedAt, a.id, actx.UserID); uerr != nil {
		return nil, uerr
	}
	kb.InvalidatePublicArticleCaches("")
	return map[string]any{
		"articleId":   idStr(a.id),
		"fromCache":   false,
		"summary":     summary,
		"generatedAt": iso(generatedAt),
	}, nil
}

// ===== 思维导图 / 知识图谱 =====

type mindmapNodeOut struct {
	ID        string            `json:"id,omitempty"`
	Topic     string            `json:"topic"`
	Root      bool              `json:"root,omitempty"`
	Expanded  bool              `json:"expanded,omitempty"`
	Direction *int              `json:"direction,omitempty"`
	Children  []*mindmapNodeOut `json:"children,omitempty"`
}

type mindmapDataOut struct {
	NodeData *mindmapNodeOut   `json:"nodeData"`
	Arrows   []mindmapArrowOut `json:"arrows,omitempty"`
}

type mindmapArrowOut struct {
	ID            string `json:"id,omitempty"`
	Label         string `json:"label"`
	From          string `json:"from"`
	To            string `json:"to"`
	Bidirectional bool   `json:"bidirectional,omitempty"`
}

const (
	mindmapMaxNodeCount        = 120
	mindmapMaxDepth            = 6
	mindmapMaxTopicLength      = 80
	mindmapMaxArrowCount       = 20
	mindmapMaxArrowLabelLength = 20
)

func buildMindmapSystemPrompt(mode string) string {
	if mode == "KNOWLEDGE_GRAPH" {
		return strings.Join([]string{
			"你是一个“文章 → 知识图谱”转换器。",
			"请根据用户提供的文章标题与 Markdown 内容，输出一个 JSON 对象（不要输出任何解释文字、不要使用 Markdown 代码块包裹）。",
			"JSON 必须符合 Mind Elixir 的 MindElixirData 结构，并包含 nodeData + arrows。",
			"规则：仅使用字段 id/topic/children/root/direction/arrows；总层级不超过 6 层；总节点数不超过 120 个；arrows 不超过 20 条；topic 必须是简短中文短语（每个不超过 80 字符）；arrow label 不超过 20 字符；不要虚构文章中不存在的具体事实。",
		}, "\n")
	}
	return strings.Join([]string{
		"你是一个“文章 → 思维导图”转换器。",
		"请根据用户提供的文章标题与 Markdown 内容，输出一个 JSON 对象（不要输出任何解释文字、不要使用 Markdown 代码块包裹）。",
		"JSON 必须符合 Mind Elixir 的 MindElixirData 最小结构：nodeData.topic/root/children。",
		"规则：仅使用字段 topic/children（可选）/root（仅根节点）；总层级不超过 6 层；总节点数不超过 120 个；topic 必须是简短中文短语（每个不超过 80 字符）；如果信息不足可适度归纳，但不要虚构不存在的具体事实。",
	}, "\n")
}

func buildMindmapUserMessage(knowledgeBaseName, title, contentMd string) string {
	content := contentMd
	if len([]rune(content)) > mindmapMaxModelInputChars {
		content = truncateRunesCopy(content, mindmapMaxModelInputChars) + "\n\n[内容已截断]"
	}
	return strings.Join([]string{
		"知识库：" + knowledgeBaseName,
		"文章标题：" + title,
		"",
		"文章 Markdown 内容：",
		content,
	}, "\n")
}

var jsonFencePrefixRe = regexp.MustCompile(`(?i)^` + "```" + `(?:json)?\s*`)

func extractJSONObjectText(raw string) (string, error) {
	text := strings.TrimSpace(jsonFencePrefixRe.ReplaceAllString(raw, ""))
	text = strings.TrimSpace(regexp.MustCompile("```$").ReplaceAllString(text, ""))
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return "", badReq("模型未返回合法 JSON")
	}
	return text[start : end+1], nil
}

type nodeCounter struct{ value int }

func firstNonEmptyStr(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func normalizeMindmapNode(raw map[string]any, fallbackTopic string, depth int, counter *nodeCounter, mode string) *mindmapNodeOut {
	topic := "未命名"
	if t := strings.TrimSpace(optStringRaw(raw["topic"])); t != "" {
		topic = t
	} else if fallbackTopic != "" {
		topic = fallbackTopic
	}
	if runes := []rune(topic); len(runes) > mindmapMaxTopicLength {
		topic = string(runes[:mindmapMaxTopicLength])
	}
	id := "root"
	if counter.value != 0 {
		id = "n" + strconv.Itoa(counter.value)
	}
	counter.value++
	node := &mindmapNodeOut{ID: id, Topic: topic}
	if mode == "KNOWLEDGE_GRAPH" {
		if d, ok := raw["direction"].(float64); ok {
			dir := 0
			if d == 1 {
				dir = 1
			}
			node.Direction = &dir
		}
	}
	children, _ := raw["children"].([]any)
	if depth < mindmapMaxDepth && counter.value < mindmapMaxNodeCount {
		for _, childRaw := range children {
			if counter.value >= mindmapMaxNodeCount {
				break
			}
			childObj, ok := childRaw.(map[string]any)
			if !ok {
				continue
			}
			node.Children = append(node.Children,
				normalizeMindmapNode(childObj, "未命名", depth+1, counter, mode))
		}
	}
	return node
}

func collectMindmapIDs(root *mindmapNodeOut) map[string]struct{} {
	ids := map[string]struct{}{}
	var walk func(n *mindmapNodeOut)
	walk = func(n *mindmapNodeOut) {
		if n.ID != "" {
			ids[n.ID] = struct{}{}
		}
		for _, child := range n.Children {
			walk(child)
		}
	}
	walk(root)
	return ids
}

func normalizeMindmapArrows(raw any, nodeIDs map[string]struct{}) []mindmapArrowOut {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := []mindmapArrowOut{}
	for index, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		label := truncateRunesCopy(firstNonEmptyStr(strings.TrimSpace(optStringRaw(entry["label"])), "关联"), mindmapMaxArrowLabelLength)
		id := strings.TrimSpace(optStringRaw(entry["id"]))
		if id == "" {
			id = "a" + strconv.Itoa(index+1)
		}
		from := strings.TrimSpace(optStringRaw(entry["from"]))
		to := strings.TrimSpace(optStringRaw(entry["to"]))
		bidirectional, _ := entry["bidirectional"].(bool)
		_, fromValid := nodeIDs[from]
		_, toValid := nodeIDs[to]
		if !fromValid || !toValid {
			continue
		}
		out = append(out, mindmapArrowOut{ID: id, Label: label, From: from, To: to, Bidirectional: bidirectional})
		if len(out) >= mindmapMaxArrowCount {
			break
		}
	}
	return out
}

func optStringRaw(v any) string {
	s, _ := v.(string)
	return s
}

func normalizeMindmapOutput(raw map[string]any, fallbackTitle, mode string) *mindmapDataOut {
	rootSource, ok := raw["nodeData"].(map[string]any)
	if !ok {
		rootSource = raw
	}
	counter := &nodeCounter{}
	fallback := strings.TrimSpace(fallbackTitle)
	if fallback == "" {
		fallback = "未命名"
	}
	root := normalizeMindmapNode(rootSource, fallback, 1, counter, mode)
	root.ID = "root"
	root.Root = true
	root.Expanded = true

	data := &mindmapDataOut{NodeData: root}
	if mode == "KNOWLEDGE_GRAPH" {
		data.Arrows = normalizeMindmapArrows(raw["arrows"], collectMindmapIDs(root))
	}
	return data
}

func knowledgeGraphLabelOf(mode string) string {
	if mode == "KNOWLEDGE_GRAPH" {
		return "知识图谱"
	}
	return "思维导图"
}

// AgentGenerateArticleMindmap POST /api/agent/article/mindmap/generate（scope ai:write）。
func AgentGenerateArticleMindmap(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "ai:write"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, err := reqID(raw["articleId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	mode := trimmedString(raw, "mode")
	if mode == "" {
		mode = "MINDMAP"
	}
	if mode != "MINDMAP" && mode != "KNOWLEDGE_GRAPH" {
		return nil, badReq("mode 非法")
	}
	forceRebuild := rawBool(raw, "forceRebuild")

	q := dbPool()
	ctx := context.Background()
	full, err := kb.QueryOwnedArticleForAgent(q, actx.UserID, articleID)
	if err != nil {
		return nil, err
	}
	if full == nil {
		return nil, notFoundErr("文章不存在")
	}
	var kbName string
	if err := q.QueryRow(ctx,
		`SELECT name FROM petrichor_kb_knowledge_base WHERE id = $1 LIMIT 1`,
		full.KnowledgeBaseID).Scan(&kbName); err != nil {
		if err == pgx.ErrNoRows {
			return nil, notFoundErr("知识库不存在")
		}
		return nil, err
	}

	currentHash := sha256HexText(strings.TrimSpace(full.Title) + "\n" + strings.TrimSpace(full.ContentMd))
	storedHash, storedJSON, storedGeneratedAt := full.MindmapContentHash, full.MindmapJson, full.MindmapGeneratedAt
	jsonColumn := "mindmap_json"
	hashColumn := "mindmap_content_hash"
	genColumn := "mindmap_generated_at"
	if mode == "KNOWLEDGE_GRAPH" {
		storedHash, storedJSON, storedGeneratedAt = full.MindmapKgContentHash, full.MindmapKgJson, full.MindmapKgGeneratedAt
		jsonColumn = "mindmap_kg_json"
		hashColumn = "mindmap_kg_content_hash"
		genColumn = "mindmap_kg_generated_at"
	}

	if !forceRebuild &&
		deref(storedJSON) != "" && deref(storedHash) != "" && deref(storedHash) == currentHash {
		cached := parseJSONObjectRaw(deref(storedJSON))
		if cached != nil {
			generatedAt := iso(full.UpdatedAt)
			if storedGeneratedAt != nil {
				generatedAt = iso(*storedGeneratedAt)
			}
			return map[string]any{
				"articleId":   idStr(full.ID),
				"mode":        mode,
				"fromCache":   true,
				"generatedAt": generatedAt,
				"data":        cached,
			}, nil
		}
	}

	answer, cerr := kb.ChatInvoker(ctx, kb.ChatRequest{
		UserID:       actx.UserID,
		SystemPrompt: buildMindmapSystemPrompt(mode),
		Message:      buildMindmapUserMessage(kbName, full.Title, full.ContentMd),
		Op:           "kb.mindmap",
	})
	if cerr != nil {
		if strings.Contains(cerr.Error(), "未找到可用的默认配置") {
			return nil, cerr
		}
		return nil, badReq("生成" + knowledgeGraphLabelOf(mode) + "失败，请稍后重试")
	}
	jsonText, terr := extractJSONObjectText(answer)
	if terr != nil {
		return nil, terr
	}
	var parsed map[string]any
	if jerr := json.Unmarshal([]byte(jsonText), &parsed); jerr != nil {
		return nil, badReq("生成" + knowledgeGraphLabelOf(mode) + "失败，请稍后重试")
	}
	generated := normalizeMindmapOutput(parsed, full.Title, mode)
	generatedJSON, merr := json.Marshal(generated)
	if merr != nil {
		return nil, badReq("生成" + knowledgeGraphLabelOf(mode) + "失败，请稍后重试")
	}
	generatedAt := time.Now()
	if _, uerr := q.Exec(ctx,
		`UPDATE petrichor_kb_article SET `+jsonColumn+` = $1, `+hashColumn+` = $2,
		 `+genColumn+` = $3, updated_at = $3 WHERE id = $4`,
		string(generatedJSON), currentHash, generatedAt, full.ID); uerr != nil {
		return nil, uerr
	}
	kb.InvalidatePublicArticleCaches("")
	return map[string]any{
		"articleId":   idStr(full.ID),
		"mode":        mode,
		"fromCache":   false,
		"generatedAt": iso(generatedAt),
		"data":        json.RawMessage(generatedJSON),
	}, nil
}

func parseJSONObjectRaw(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil
	}
	var parsed map[string]any
	if json.Unmarshal([]byte(trimmed), &parsed) != nil {
		return nil
	}
	return parsed
}
