// sitegraph_llm.go 对照 src/server/site-graph/extract-agent.ts 的模型调用部分：
// 解析 SiteGraphGeneratorFn 注入点的 input（本批文章 + 已知实体清单）→
// 构造抽取提示词（系统提示与 TS 逐条对齐）→ 调 CHAT 用途绑定模型 →
// 提取 JSON 输出（失败重试 1 次）→ 按注入点契约返回 {"nodes":[],"edges":[],"modelName"}。
//
// 幻觉拦截 / 实体注册表对齐仍由 sitegraph_service.go 的 parseExtractionResult /
// alignNodesWithRegistry 负责，这里只负责把模型原文变成合法的结构化输出。
package adminpanel

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"petrichor/api/internal/aicore"
)

// siteGraphLLMArticle 单篇送入模型的文章（input.articles 的元素形态）。
type siteGraphLLMArticle struct {
	ArticleID         string
	Title             string
	Route             string
	Excerpt           string
	Tags              []string
	ContentMd         string
	UpdatedAt         string
	KnowledgeBaseName string
	NodeKey           string
}

// SiteGraphLLMGenerator 注入 adminpanel.SiteGraphGeneratorFn 的 LLM 实现。
func SiteGraphLLMGenerator(ctx context.Context, input map[string]any) (map[string]any, error) {
	userID := toInt64Value(input["userId"])
	modelRefID, _ := input["modelRefId"].(*int64)
	rawArticles, _ := input["articles"].([]any)
	knownEntities, _ := input["knownEntities"].([]EntityRegistryEntry)

	articles := make([]siteGraphLLMArticle, 0, len(rawArticles))
	for _, item := range rawArticles {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		tags := []string{}
		if list, ok := record["tags"].([]string); ok {
			tags = list
		}
		articles = append(articles, siteGraphLLMArticle{
			ArticleID:         toStringValue(record["articleId"]),
			Title:             toStringValue(record["title"]),
			Route:             toStringValue(record["route"]),
			Excerpt:           toStringValue(record["excerpt"]),
			Tags:              tags,
			ContentMd:         toStringValue(record["contentMd"]),
			UpdatedAt:         toStringValue(record["updatedAt"]),
			KnowledgeBaseName: toStringValue(record["knowledgeBaseName"]),
			NodeKey:           toStringValue(record["nodeKey"]),
		})
	}
	if len(articles) == 0 {
		return nil, fmt.Errorf("抽取批次没有可用文章")
	}

	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeChat, modelRefID)
	if err != nil {
		return nil, err
	}
	rt := resolved.Runtime
	rt.Quirks = aicore.ResolveQuirks(rt.ProviderKey, resolved.ModelRef)

	msgs := []aicore.ChatMessage{
		{Role: "system", Content: siteGraphExtractionSystemPrompt()},
		{Role: "user", Content: siteGraphExtractionUserMessage(articles, knownEntities)},
	}

	var answer string
	for attempt := 0; ; attempt++ {
		result, cerr := aicore.Chat(ctx, rt, resolved.ModelRef, msgs, resolved.Options)
		if cerr != nil {
			return nil, cerr
		}
		answer = result.Answer
		parsed, perr := extractJSONObjectMap(answer)
		if perr == nil {
			nodes, _ := parsed["nodes"].([]any)
			edges, _ := parsed["edges"].([]any)
			if nodes == nil {
				nodes = []any{}
			}
			if edges == nil {
				edges = []any{}
			}
			return map[string]any{
				"nodes":     nodes,
				"edges":     edges,
				"modelName": resolved.ModelRef,
			}, nil
		}
		if attempt >= 1 {
			// JSON 解析失败重试 1 次后仍失败：交由上层按批记 warning。
			return nil, fmt.Errorf("模型未返回合法 JSON：%v", perr)
		}
	}
}

// toInt64Value 弱类型取整数（注入 input 的 userId 为 int64 直传，兜底兼容数值形态）。
func toInt64Value(raw any) int64 {
	switch v := raw.(type) {
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case json.Number:
		n, _ := v.Int64()
		return n
	default:
		return 0
	}
}

// siteGraphExtractionSystemPrompt 对照 extract-agent.ts buildExtractionSystemPrompt，
// 上限值取自 sitegraph_types.go 的 Limit* 常量（与 TS SITE_GRAPH_LIMITS 一致）。
func siteGraphExtractionSystemPrompt() string {
	return strings.Join([]string{
		`你是「站点知识图谱抽取器」。输入是若干篇公开文章，输出这些文章共同构成的概念图谱。`,
		``,
		`只输出一个 JSON 对象，不要任何解释文字，不要用 Markdown 代码块包裹。结构固定为：`,
		`{`,
		`  "nodes": [`,
		`    {`,
		`      "nodeKey": "concept-向量检索",`,
		`      "name": "向量检索",`,
		`      "kind": "concept",`,
		`      "summary": "一句话说明这个概念在这些文章里指什么",`,
		`      "aliases": ["vector search"],`,
		`      "attributes": [`,
		`        { "name": "类别", "value": "检索技术" },`,
		`        { "name": "典型场景", "value": "RAG 问答" }`,
		`      ],`,
		`      "confidence": 88`,
		`    }`,
		`  ],`,
		`  "edges": [`,
		`    {`,
		`      "fromKey": "article-12",`,
		`      "toKey": "concept-向量检索",`,
		`      "relation": "阐述",`,
		`      "kind": "reference",`,
		`      "attributes": [{ "name": "依据", "value": "文中第 2 节" }],`,
		`      "confidence": 90`,
		`    }`,
		`  ]`,
		`}`,
		``,
		`节点规则：`,
		fmt.Sprintf(`- kind 只能是 concept（抽象概念）或 entity（具体实体：产品、库、人物、组织、协议等）`),
		`- nodeKey 用 "concept-" 或 "entity-" 前缀加中文/英文短名，同一事物在不同文章里必须复用同一个 nodeKey`,
		fmt.Sprintf(`- name 不超过 %d 字；summary 不超过 %d 字`, LimitNameLength, LimitSummaryLength),
		fmt.Sprintf(`- attributes 是该节点的结构化属性，最多 %d 条，属性名不超过 %d 字、属性值不超过 %d 字`,
			LimitAttributesPerItem, LimitAttrNameLength, LimitAttrValueLength),
		fmt.Sprintf(`- aliases 是同义写法（中英文别名、缩写），最多 %d 个`, LimitAliasesPerNode),
		`- 每批最多产出 12 个节点，只保留真正有信息量的，不要把段落标题当概念`,
		`- 不要输出文章节点，文章节点由系统生成`,
		``,
		`关系规则：`,
		`- fromKey / toKey 必须是本次输入中给出的文章节点键（article-数字），或本次 nodes 里定义的 nodeKey`,
		fmt.Sprintf(`- relation 是不超过 %d 字的中文短语，例如：阐述、依赖、对比、属于、演进自、替代`, LimitRelationLength),
		`- kind 只能是 reference（文章引用概念）、semantic（概念之间语义关联）、derived（由前者衍生）`,
		`- confidence 是 0~100 的整数，表示你对这条判断的把握`,
		`- 每批最多 20 条关系；不要给出自己指向自己的关系`,
		`- 不要虚构文章中不存在的事实`,
	}, "\n")
}

// siteGraphExtractionUserMessage 对照 extract-agent.ts buildExtractionUserMessage：
// 文章键清单 → 已知实体回喂块（复用规范键减少同义分裂）→ 正文分块。
func siteGraphExtractionUserMessage(articles []siteGraphLLMArticle, knownEntities []EntityRegistryEntry) string {
	keyLines := make([]string, 0, len(articles))
	for _, article := range articles {
		keyLines = append(keyLines, "- "+article.NodeKey+"（"+article.Title+"）")
	}

	knownLines := []string{}
	if len(knownEntities) > 0 {
		entityLines := make([]string, 0, len(knownEntities))
		for _, entry := range knownEntities {
			line := "- " + entry.CanonicalKey + "（" + entry.Name
			if len(entry.Aliases) > 0 {
				line += "，别名：" + strings.Join(entry.Aliases, "、")
			}
			entityLines = append(entityLines, line+"）")
		}
		knownLines = append(knownLines,
			"站点已有的概念/实体（如本批内容涉及其中任何一个，必须直接复用它的 nodeKey，不要另起新名）：",
			strings.Join(entityLines, "\n"),
			"")
	}

	blocks := make([]string, 0, len(articles))
	for _, article := range articles {
		section := article.KnowledgeBaseName
		if strings.TrimSpace(section) == "" {
			section = "未分类"
		}
		tagText := "标签：（无）"
		if len(article.Tags) > 0 {
			tagText = "标签：" + strings.Join(article.Tags, "、")
		}
		lines := []string{
			"### 文章节点键：" + article.NodeKey,
			"标题：" + article.Title,
			"分类：" + section,
			tagText,
			"正文：",
			article.ContentMd,
		}
		blocks = append(blocks, strings.Join(lines, "\n"))
	}

	header := fmt.Sprintf("本批共 %d 篇公开文章，请抽取它们共同的概念/实体节点及关系。", len(articles))
	return strings.Join(append([]string{
		header,
		"可被关系引用的文章节点键：",
		strings.Join(keyLines, "\n"),
		"",
	}, append(knownLines, strings.Join(blocks, "\n\n---\n\n"))...), "\n")
}

// extractJSONObjectMap 复刻 normalize.ts extractJsonObjectText + JSON.parse：
// 剥掉代码围栏后取首个 { 到最后一个 } 之间的内容解析为对象。
func extractJSONObjectMap(rawText string) (map[string]any, error) {
	jsonText := extractJSONText(rawText)
	if jsonText == "" {
		return nil, fmt.Errorf("输出中找不到 JSON 对象")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(jsonText), &parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}

func extractJSONText(rawText string) string {
	text := strings.TrimSpace(rawText)
	if text == "" {
		return ""
	}
	// 模型偶尔无视指令用 ```json ... ``` 包裹整体
	if strings.HasPrefix(text, "```") {
		if end := strings.LastIndex(text, "```"); end > 3 {
			text = strings.TrimSpace(text[3:end])
		} else {
			text = strings.TrimSpace(strings.TrimPrefix(text, "```"))
		}
		text = strings.TrimPrefix(text, "json")
		text = strings.TrimSpace(text)
	}
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end <= start {
		return ""
	}
	return text[start : end+1]
}
