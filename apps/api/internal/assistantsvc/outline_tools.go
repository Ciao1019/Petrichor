// outline_tools.go knowledge.outline：按文档目录结构导航，而不是按相似度召回。
//
// 三路混合召回擅长「哪一段最像这个问题」，但对结构性问题很弱——
// 「这份合同哪几章涉及违约」「按时间顺序汇总」这类需求里，
// 相似度会把文档结构打散。这个工具直接把一篇文档的目录摊给模型，
// 由模型自己决定读哪几节，再用返回的 nodeKey / chunkId 走 knowledge.read。
//
// 数据来源有两个：ingest 编译出的 PageIndex 目录树（带 LLM 章节摘要，优先），
// 以及「构建知识」产出的分片标题路径（每篇构建过的文章都有，作为兜底）。
package assistantsvc

import (
	"encoding/json"
	"fmt"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

const outlineSchema = `{"type":"object","properties":{"articleId":{"type":"string","description":"要看目录的文章 ID"},"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"maxNodes":{"type":"integer","minimum":10,"maximum":300,"description":"最多返回的章节数，缺省 120"}},"required":["articleId"]}`

// outlineDefaultMaxNodes 默认返回的章节上限。
const outlineDefaultMaxNodes = 120

// outlineNode 目录里的一个章节。
type outlineNode struct {
	NodeKey       string `json:"nodeKey,omitempty"`
	ChunkID       string `json:"chunkId,omitempty"`
	ParentKey     string `json:"parentKey,omitempty"`
	Depth         int    `json:"depth"`
	Title         string `json:"title"`
	Path          string `json:"path,omitempty"`
	Summary       string `json:"summary,omitempty"`
	TokenEstimate int    `json:"tokenEstimate,omitempty"`
	// Questions 是构建知识时为该分片生成的推荐问题。
	// 目录树路径没有这项；分片路径有，它比标题更能说明这一节回答了什么。
	Questions []string `json:"questions,omitempty"`
}

// outlineMaxQuestionsPerNode 每节最多带回的推荐问题数。
const outlineMaxQuestionsPerNode = 3

func registerOutlineTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.outline", Name: "read_document_outline", Namespace: rt.NamespaceKnowledge,
		Description: "读取一篇文档的完整目录结构（章节标题、层级、摘要、篇幅估算），不返回正文。" +
			"适合结构性问题：某文档里哪几章讲了某主题、按章节顺序汇总、定位「第几节」。" +
			"拿到目录后用返回的 nodeKey 或 chunkId 调 knowledge.read / read_many 深读。",
		InputSchema: schemaJSON(outlineSchema),
		RiskLevel:   rt.RiskLow, Core: true, Tags: []string{"retrieval"},
		Execute:   executeKnowledgeOutline,
		Normalize: normalizeOutlineOutput,
	})
}

func executeKnowledgeOutline(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	articleID := parseID(params["articleId"])
	if articleID <= 0 {
		if id, ok := focusInt(ctx.Focus, "articleId"); ok {
			articleID = id
		}
	}
	if articleID <= 0 {
		return nil, fmt.Errorf("需要 articleId 才能读取文档目录")
	}
	maxNodes := outlineDefaultMaxNodes
	if v := parseID(params["maxNodes"]); v >= 10 && v <= 300 {
		maxNodes = int(v)
	}

	article, err := loadOutlineArticle(ctx, articleID)
	if err != nil {
		return nil, err
	}

	nodes, source, err := loadOutlineNodes(ctx, articleID, maxNodes)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"articleId":       fmt.Sprintf("%d", articleID),
		"knowledgeBaseId": fmt.Sprintf("%d", article.knowledgeBaseID),
		"title":           article.title,
		"source":          source,
		"nodeCount":       len(nodes),
		"truncated":       len(nodes) >= maxNodes,
		"nodes":           nodes,
	}, nil
}

type outlineArticle struct {
	knowledgeBaseID int64
	title           string
}

// loadOutlineArticle 取文章并确认属于当前用户；越权直接当作不存在。
func loadOutlineArticle(ctx *rt.ToolExecutionContext, articleID int64) (*outlineArticle, error) {
	var out outlineArticle
	err := dbPool().QueryRow(toolContext(ctx),
		`SELECT knowledge_base_id, title FROM petrichor_kb_article
		 WHERE id = $1 AND user_id = $2 LIMIT 1`, articleID, ctx.UserID).
		Scan(&out.knowledgeBaseID, &out.title)
	if err != nil {
		return nil, fmt.Errorf("文章不存在或无权访问")
	}
	return &out, nil
}

// loadOutlineNodes 优先用 PageIndex 目录树；没有树时回落到分片标题路径。
func loadOutlineNodes(ctx *rt.ToolExecutionContext, articleID int64, maxNodes int) ([]outlineNode, string, error) {
	nodes, err := loadTreeOutline(ctx, articleID, maxNodes)
	if err != nil {
		return nil, "", err
	}
	if len(nodes) > 0 {
		return nodes, "wiki_tree", nil
	}
	nodes, err = loadChunkOutline(ctx, articleID, maxNodes)
	if err != nil {
		return nil, "", err
	}
	if len(nodes) == 0 {
		return []outlineNode{}, "none", nil
	}
	return nodes, "chunk_headings", nil
}

func loadTreeOutline(ctx *rt.ToolExecutionContext, articleID int64, maxNodes int) ([]outlineNode, error) {
	rows, err := dbPool().Query(toolContext(ctx),
		`SELECT node_key, COALESCE(parent_key,''), depth, title, COALESCE(summary,''), token_estimate
		 FROM petrichor_kb_wiki_tree_node
		 WHERE user_id = $1 AND article_id = $2
		 ORDER BY depth ASC, "position" ASC
		 LIMIT $3`, ctx.UserID, articleID, maxNodes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := []outlineNode{}
	for rows.Next() {
		var node outlineNode
		if err := rows.Scan(&node.NodeKey, &node.ParentKey, &node.Depth,
			&node.Title, &node.Summary, &node.TokenEstimate); err != nil {
			return nil, err
		}
		nodes = append(nodes, node)
	}
	return nodes, rows.Err()
}

func loadChunkOutline(ctx *rt.ToolExecutionContext, articleID int64, maxNodes int) ([]outlineNode, error) {
	rows, err := dbPool().Query(toolContext(ctx),
		`SELECT id, heading, heading_path_json, LENGTH(content_md), recommended_questions_json
		 FROM petrichor_kb_article_chunk
		 WHERE user_id = $1 AND article_id = $2
		 ORDER BY "position" ASC
		 LIMIT $3`, ctx.UserID, articleID, maxNodes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	nodes := []outlineNode{}
	for rows.Next() {
		var chunkID int64
		var heading, headingPathJSON, questionsJSON string
		var contentLen int
		if err := rows.Scan(&chunkID, &heading, &headingPathJSON, &contentLen, &questionsJSON); err != nil {
			return nil, err
		}
		path := parseHeadingPath(headingPathJSON)
		node := outlineNode{
			ChunkID: fmt.Sprintf("%d", chunkID),
			Depth:   len(path),
			Title:   heading,
			// 分片没有 LLM 摘要，用字符数粗估 token，够模型判断篇幅。
			TokenEstimate: contentLen / 3,
			Questions:     limitStrings(parseHeadingPath(questionsJSON), outlineMaxQuestionsPerNode),
		}
		if len(path) > 0 {
			node.Path = strings.Join(path, " > ")
			if node.Depth > 0 {
				node.Depth--
			}
		}
		nodes = append(nodes, node)
	}
	return nodes, rows.Err()
}

// limitStrings 截断到 limit 项。
func limitStrings(values []string, limit int) []string {
	if len(values) <= limit {
		return values
	}
	return values[:limit]
}

// parseHeadingPath 解析分片存的字符串 JSON 数组（标题路径 / 推荐问题）；
// 解析失败按空处理，不让脏数据打断整份目录。
func parseHeadingPath(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var path []string
	if err := json.Unmarshal([]byte(raw), &path); err != nil {
		return nil
	}
	out := make([]string, 0, len(path))
	for _, item := range path {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func normalizeOutlineOutput(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Title     string        `json:"title"`
		Source    string        `json:"source"`
		NodeCount int           `json:"nodeCount"`
		Truncated bool          `json:"truncated"`
		Nodes     []outlineNode `json:"nodes"`
	}
	_ = json.Unmarshal(raw, &parsed)

	if parsed.NodeCount == 0 {
		return rt.ToolNormalizerResult{
			Summary:          "《" + parsed.Title + "》还没有可用目录，先执行一次知识构建",
			SuggestedActions: []string{"knowledge.search"},
		}
	}
	summary := "《" + parsed.Title + "》目录共 " + fmt.Sprintf("%d", parsed.NodeCount) + " 节"
	if parsed.Source == "chunk_headings" {
		summary += "（来自分片标题）"
	}
	if parsed.Truncated {
		summary += "，已截断"
	}
	return rt.ToolNormalizerResult{
		Summary:          summary,
		SuggestedActions: []string{"knowledge.read_many", "knowledge.read"},
	}
}
