// mindmap-summary.go 对照 mindmap-handlers.ts 与 article-summary-handlers.ts。
// 两者都依赖 LLM，走 ChatInvoker 注入（nil 时 503「AI 服务未就绪」）。
package kb

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	mindmapMaxModelInputChars = 12000
	summaryMaxModelInputChars = 12000
	summaryMaxChars           = 420
)

// ===== 思维导图 / 知识图谱 =====

type mindmapNode struct {
	ID        string         `json:"id,omitempty"`
	Topic     string         `json:"topic"`
	Root      bool           `json:"root,omitempty"`
	Expanded  bool           `json:"expanded,omitempty"`
	Direction *int           `json:"direction,omitempty"`
	Children  []*mindmapNode `json:"children,omitempty"`
}

type mindmapData struct {
	NodeData *mindmapNode   `json:"nodeData"`
	Arrows   []mindmapArrow `json:"arrows,omitempty"`
}

type mindmapArrow struct {
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
		content = truncateRunes(content, mindmapMaxModelInputChars) + "\n\n[内容已截断]"
	}
	return strings.Join([]string{
		"知识库：" + knowledgeBaseName,
		"文章标题：" + title,
		"",
		"文章 Markdown 内容：",
		content,
	}, "\n")
}

var jsonFencePrefix = regexp.MustCompile("(?i)^```(?:json)?\\s*")

// extractJsonObjectText 对应 mindmap-logic.ts 同名函数：剥围栏后截取 {..}。
func extractJsonObjectText(raw string) (string, error) {
	text := trimSpace(jsonFencePrefix.ReplaceAllString(raw, ""))
	text = trimSpace(regexp.MustCompile("```$").ReplaceAllString(text, ""))
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return "", badReq("模型未返回合法 JSON")
	}
	return text[start : end+1], nil
}

type nodeCounter struct{ value int }

func normalizeMindmapNode(raw map[string]any, fallbackTopic string, depth int, counter *nodeCounter, mode string) *mindmapNode {
	topic := "未命名"
	if s := optString(raw["topic"]); trimSpace(s) != "" {
		topic = trimSpace(s)
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
	node := &mindmapNode{ID: id, Topic: topic}
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

// normalizeMindmapModelOutput 对应同名函数：结构归一、限量、KG 模式补 arrows。
func normalizeMindmapModelOutput(raw map[string]any, fallbackTitle, mode string) *mindmapData {
	rootSource, ok := raw["nodeData"].(map[string]any)
	if !ok {
		rootSource = raw
	}
	counter := &nodeCounter{}
	fallback := fallbackTitle
	if trimSpace(fallback) == "" {
		fallback = "未命名"
	}
	root := normalizeMindmapNode(rootSource, fallback, 1, counter, mode)
	root.ID = "root"
	root.Root = true
	root.Expanded = true

	data := &mindmapData{NodeData: root}
	if mode == "KNOWLEDGE_GRAPH" {
		data.Arrows = normalizeArrows(raw["arrows"], collectNodeIDs(root))
	}
	return data
}

func collectNodeIDs(root *mindmapNode) map[string]struct{} {
	ids := map[string]struct{}{}
	var walk func(n *mindmapNode)
	walk = func(n *mindmapNode) {
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

func normalizeArrows(raw any, nodeIDs map[string]struct{}) []mindmapArrow {
	list, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := []mindmapArrow{}
	for index, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		label := truncateRunes(firstNonEmpty(trimSpace(optString(entry["label"])), "关联"), mindmapMaxArrowLabelLength)
		id := trimSpace(optString(entry["id"]))
		if id == "" {
			id = "a" + strconv.Itoa(index+1)
		}
		from := trimSpace(optString(entry["from"]))
		to := trimSpace(optString(entry["to"]))
		bidirectional, _ := entry["bidirectional"].(bool)
		_, fromValid := nodeIDs[from]
		_, toValid := nodeIDs[to]
		if !fromValid || !toValid {
			continue
		}
		out = append(out, mindmapArrow{ID: id, Label: label, From: from, To: to, Bidirectional: bidirectional})
		if len(out) >= mindmapMaxArrowCount {
			break
		}
	}
	return out
}

// GenerateArticleMindmap 思维导图 / 知识图谱生成（带内容哈希缓存）。
func GenerateArticleMindmap(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		if err := requireChat(); err != nil {
			return nil, err
		}
		articleIDText := trimmedString(raw, "articleId")
		if articleIDText == "" {
			return nil, badReq("不能为空")
		}
		articleID, err := reqID(articleIDText, `需要匹配正则表达式"\d+"`)
		if err != nil {
			return nil, err
		}
		mode := trimmedString(raw, "mode")
		if mode != "" && mode != "MINDMAP" && mode != "KNOWLEDGE_GRAPH" {
			return nil, badReq("mode 非法")
		}
		if mode != "KNOWLEDGE_GRAPH" {
			mode = "MINDMAP"
		}
		forceRebuild := rawBool(raw, "forceRebuild")

		q := pool()
		article, err := queryArticle(q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE id = $1 LIMIT 1`, articleID)
		if err != nil {
			return nil, err
		}
		if article == nil || article.UserID != user.ID {
			return nil, notFoundErr("文章不存在")
		}
		kbRow, err := scanKB(q.QueryRow(c,
			`SELECT `+kbColumns+` FROM petrichor_kb_knowledge_base WHERE id = $1 LIMIT 1`,
			article.KnowledgeBaseID))
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, notFoundErr("知识库不存在")
			}
			return nil, err
		}

		currentHash := sha256Hex(trimSpace(article.Title) + "\n" + trimSpace(article.ContentMd))
		storedHash, storedJSON, storedGeneratedAt := article.MindmapContentHash, article.MindmapJson, article.MindmapGeneratedAt
		if mode == "KNOWLEDGE_GRAPH" {
			storedHash, storedJSON, storedGeneratedAt = article.MindmapKgContentHash, article.MindmapKgJson, article.MindmapKgGeneratedAt
		}

		if !forceRebuild &&
			derefStr(storedJSON) != "" && derefStr(storedHash) != "" && derefStr(storedHash) == currentHash {
			cached := parseJSONObject(storedJSON)
			if cached != nil {
				generatedAt := iso(article.UpdatedAt)
				if storedGeneratedAt != nil {
					generatedAt = iso(*storedGeneratedAt)
				}
				return map[string]any{
					"articleId":   strconv.FormatInt(article.ID, 10),
					"fromCache":   true,
					"generatedAt": generatedAt,
					"data":        cached,
				}, nil
			}
		}

		answer, err := ChatInvoker(c, ChatRequest{
			UserID:       user.ID,
			SystemPrompt: buildMindmapSystemPrompt(mode),
			Message:      buildMindmapUserMessage(kbRow.Name, article.Title, article.ContentMd),
			Op:           "kb.mindmap",
		})
		if err != nil {
			if strings.Contains(err.Error(), "未找到可用的默认配置") {
				return nil, err
			}
			return nil, badReq("生成" + knowledgeGraphLabel(mode) + "失败，请稍后重试")
		}
		jsonText, terr := extractJsonObjectText(answer)
		if terr != nil {
			return nil, terr
		}
		var parsed map[string]any
		if jerr := json.Unmarshal([]byte(jsonText), &parsed); jerr != nil {
			return nil, badReq("生成" + knowledgeGraphLabel(mode) + "失败，请稍后重试")
		}
		generated := normalizeMindmapModelOutput(parsed, article.Title, mode)
		generatedJSON := marshalJSON(generated)
		generatedAt := time.Now()

		if mode == "KNOWLEDGE_GRAPH" {
			if _, uerr := q.Exec(c,
				`UPDATE petrichor_kb_article SET mindmap_kg_json = $1, mindmap_kg_content_hash = $2,
				 mindmap_kg_generated_at = $3, updated_at = $3 WHERE id = $4`,
				generatedJSON, currentHash, generatedAt, article.ID); uerr != nil {
				return nil, uerr
			}
		} else {
			if _, uerr := q.Exec(c,
				`UPDATE petrichor_kb_article SET mindmap_json = $1, mindmap_content_hash = $2,
				 mindmap_generated_at = $3, updated_at = $3 WHERE id = $4`,
				generatedJSON, currentHash, generatedAt, article.ID); uerr != nil {
				return nil, uerr
			}
		}
		invalidatePublicArticleListCache()
		invalidatePublicArticleDetailCache("")
		return map[string]any{
			"articleId":   strconv.FormatInt(article.ID, 10),
			"fromCache":   false,
			"generatedAt": iso(generatedAt),
			"data":        json.RawMessage(derefStr(generatedJSON)),
		}, nil
	})
}

func knowledgeGraphLabel(mode string) string {
	if mode == "KNOWLEDGE_GRAPH" {
		return "知识图谱"
	}
	return "思维导图"
}

// ===== AI 摘要 =====

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

func buildArticleSummaryUserMessage(title, contentMd string) string {
	content := contentMd
	if len([]rune(content)) > summaryMaxModelInputChars {
		content = truncateRunes(content, summaryMaxModelInputChars) + "\n\n[内容已截断]"
	}
	return strings.Join([]string{
		"文章标题：" + title,
		"",
		"文章 Markdown 正文：",
		content,
	}, "\n")
}

var (
	summaryFenceHead = regexp.MustCompile("(?i)^```(?:markdown|md|text)?\\s*")
	summaryFenceTail = regexp.MustCompile("(?i)```$")
	// Go regexp 默认启用 Unicode，无需 (?u)/(?iu) 标志（对应 JS 正则的 /u 修饰）。
	summaryHeading = regexp.MustCompile(`^#{1,6}\s*摘要\s*`)
	summaryLabel   = regexp.MustCompile(`(?i)^(文章)?(AI\s*)?摘要[:：]\s*`)
)

// normalizeArticleSummaryModelOutput 清洗模型输出并限长（420 字符）。
func normalizeArticleSummaryModelOutput(raw string) (string, error) {
	normalized := trimSpace(summaryFenceHead.ReplaceAllString(raw, ""))
	normalized = trimSpace(summaryLabel.ReplaceAllString(normalized, ""))
	normalized = trimSpace(summaryHeading.ReplaceAllString(normalized, ""))
	normalized = trimSpace(summaryFenceTail.ReplaceAllString(normalized, ""))
	normalized = spaceRe.ReplaceAllString(normalized, " ")
	normalized = trimSpace(normalized)
	if normalized == "" {
		return "", badReq("模型未返回有效摘要")
	}
	runes := []rune(normalized)
	if len(runes) > summaryMaxChars {
		return trimRightSpace(string(runes[:summaryMaxChars])) + "...", nil
	}
	return normalized, nil
}

// GenerateArticleSummary AI 摘要生成（带内容哈希缓存）。
func GenerateArticleSummary(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		if err := requireChat(); err != nil {
			return nil, err
		}
		articleIDText := trimmedString(raw, "articleId")
		if articleIDText == "" {
			return nil, badReq("文章ID不能为空")
		}
		articleID, err := reqID(articleIDText, "文章ID非法")
		if err != nil {
			return nil, err
		}
		forceRebuild := rawBool(raw, "forceRebuild")

		q := pool()
		article, err := queryArticle(q,
			`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE id = $1 AND user_id = $2 LIMIT 1`,
			articleID, user.ID)
		if err != nil {
			return nil, err
		}
		if article == nil {
			return nil, notFoundErr("文章不存在")
		}
		currentHash := md5Hex(article.ContentMd)
		if !forceRebuild &&
			derefStr(article.AiSummary) != "" && derefStr(article.AiSummaryContentHash) == currentHash {
			summaryAt := iso(article.UpdatedAt)
			if article.AiSummaryGeneratedAt != nil {
				summaryAt = iso(*article.AiSummaryGeneratedAt)
			}
			return map[string]any{
				"articleId":   strconv.FormatInt(article.ID, 10),
				"fromCache":   true,
				"summary":     trimSpace(derefStr(article.AiSummary)),
				"generatedAt": summaryAt,
			}, nil
		}

		answer, err := ChatInvoker(c, ChatRequest{
			UserID:       user.ID,
			SystemPrompt: buildArticleSummarySystemPrompt(),
			Message:      buildArticleSummaryUserMessage(article.Title, article.ContentMd),
			Op:           "kb.summary",
		})
		if err != nil {
			return nil, err
		}
		summary, nerr := normalizeArticleSummaryModelOutput(answer)
		if nerr != nil {
			return nil, nerr
		}
		generatedAt := time.Now()
		if _, uerr := q.Exec(c,
			`UPDATE petrichor_kb_article SET ai_summary = $1, ai_summary_content_hash = $2,
			 ai_summary_generated_at = $3, updated_at = $3 WHERE id = $4 AND user_id = $5`,
			summary, currentHash, generatedAt, article.ID, user.ID); uerr != nil {
			return nil, uerr
		}
		invalidatePublicArticleListCache()
		invalidatePublicArticleDetailCache("")
		return map[string]any{
			"articleId":   strconv.FormatInt(article.ID, 10),
			"fromCache":   false,
			"summary":     summary,
			"generatedAt": iso(generatedAt),
		}, nil
	})
}
