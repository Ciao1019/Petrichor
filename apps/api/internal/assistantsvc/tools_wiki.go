package assistantsvc

import (
	"encoding/json"
	"fmt"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

type wikiMentionObservationPage struct {
	PageKey string   `json:"pageKey"`
	Title   string   `json:"title"`
	Kind    string   `json:"kind,omitempty"`
	Aliases []string `json:"aliases"`
}

func appendWikiMentionObservationPage(
	pages []wikiMentionObservationPage,
	byKey map[string]int,
	page wikiMentionObservationPage,
) []wikiMentionObservationPage {
	page.PageKey = strings.TrimSpace(page.PageKey)
	page.Title = strings.TrimSpace(page.Title)
	page.Kind = strings.ToLower(strings.TrimSpace(page.Kind))
	if page.PageKey == "" {
		return pages
	}
	if page.Title == "" {
		page.Title = page.PageKey
	}
	cleanAliases := make([]string, 0, len(page.Aliases))
	aliasSeen := map[string]bool{}
	for _, alias := range page.Aliases {
		alias = strings.TrimSpace(alias)
		key := strings.ToLower(alias)
		if alias == "" || aliasSeen[key] {
			continue
		}
		aliasSeen[key] = true
		cleanAliases = append(cleanAliases, alias)
	}
	page.Aliases = cleanAliases

	key := strings.ToLower(page.PageKey)
	if index, exists := byKey[key]; exists {
		current := &pages[index]
		if current.Title == current.PageKey && page.Title != page.PageKey {
			current.Title = page.Title
		}
		if current.Kind == "" && page.Kind != "" {
			current.Kind = page.Kind
		}
		for _, alias := range page.Aliases {
			aliasKey := strings.ToLower(alias)
			found := false
			for _, currentAlias := range current.Aliases {
				if strings.ToLower(currentAlias) == aliasKey {
					found = true
					break
				}
			}
			if !found {
				current.Aliases = append(current.Aliases, alias)
			}
		}
		return pages
	}
	byKey[key] = len(pages)
	return append(pages, page)
}

func normalizeReadOutput(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Results []struct {
			Kind        string                       `json:"kind"`
			PageKind    string                       `json:"pageKind"`
			Title       string                       `json:"title"`
			Aliases     []string                     `json:"aliases"`
			Path        json.RawMessage              `json:"path"`
			Content     string                       `json:"content"`
			KbID        string                       `json:"knowledgeBaseId"`
			ArticleID   string                       `json:"articleId"`
			ChunkID     string                       `json:"chunkId"`
			PageKey     string                       `json:"pageKey"`
			NodeKey     string                       `json:"nodeKey"`
			ContentFrom string                       `json:"contentFrom"`
			Links       []wikiMentionObservationPage `json:"links"`
			InLinks     []wikiMentionObservationPage `json:"inLinks"`
		} `json:"results"`
		RequestedCount int      `json:"requestedCount"`
		SkippedCount   int      `json:"skippedCount"`
		Failures       []string `json:"failures"`
	}
	_ = json.Unmarshal(raw, &parsed)
	totalChars := 0
	evidence := make([]rt.EvidenceInput, 0, len(parsed.Results))
	pages := make([]wikiMentionObservationPage, 0, 16)
	pageIndex := map[string]int{}
	for _, r := range parsed.Results {
		if r.PageKey != "" {
			kind := r.PageKind
			if kind == "" {
				kind = r.Kind
			}
			pages = appendWikiMentionObservationPage(pages, pageIndex, wikiMentionObservationPage{
				PageKey: r.PageKey, Title: r.Title, Kind: kind, Aliases: r.Aliases,
			})
		}
		for _, page := range r.Links {
			pages = appendWikiMentionObservationPage(pages, pageIndex, page)
		}
		for _, page := range r.InLinks {
			pages = appendWikiMentionObservationPage(pages, pageIndex, page)
		}
		totalChars += len([]rune(r.Content))
		if strings.TrimSpace(r.Content) == "" {
			continue
		}
		mentionKind := r.PageKind
		if mentionKind == "" {
			mentionKind = r.Kind
		}
		meta := map[string]any{"kind": mentionKind}
		if r.ArticleID != "" {
			meta["articleId"] = r.ArticleID
		}
		if r.KbID != "" {
			meta["knowledgeBaseId"] = r.KbID
		}
		if r.ChunkID != "" {
			meta["chunkId"] = r.ChunkID
		}
		if r.PageKey != "" {
			meta["pageKey"] = r.PageKey
		}
		if len(r.Aliases) > 0 {
			meta["aliases"] = r.Aliases
		}
		if r.NodeKey != "" {
			meta["nodeKey"] = r.NodeKey
		}
		if r.ContentFrom != "" {
			meta["contentFrom"] = r.ContentFrom
		}
		var path []string
		if len(r.Path) > 0 {
			if json.Unmarshal(r.Path, &path) != nil {
				var pathText string
				if json.Unmarshal(r.Path, &pathText) == nil && pathText != "" {
					path = strings.Split(pathText, " › ")
				}
			}
		}
		if len(path) > 0 {
			meta["path"] = path
		}
		content := trimSpace(r.Content)
		if r.Kind == "wiki_page" && r.PageKey != "" {
			content = "[Wiki 页面 " + r.Title + "]\n\n" + content
		} else {
			content = truncateRunes(content, 4000)
		}
		evidence = append(evidence, rt.EvidenceInput{
			Source: map[bool]rt.EvidenceSourceAlias{true: rt.EvidenceWiki, false: rt.EvidenceKnowledge}[r.Kind == "wiki_page"], Title: r.Title,
			Content: content, Relevance: floatPtr(0.8), Confidence: floatPtr(0.8),
			FullRead: r.Kind == "wiki_page", SourceID: firstNonEmpty(r.ChunkID, r.NodeKey, r.PageKey), Metadata: meta,
		})
	}
	summary := "读取结果为空"
	if len(evidence) > 0 {
		summary = fmt.Sprintf("已读取 %d 个目标（合计 %d 字）", len(evidence), totalChars)
		if len(parsed.Failures) > 0 || parsed.SkippedCount > 0 {
			summary += fmt.Sprintf("；%d 个失败，%d 个按复杂度跳过", len(parsed.Failures), parsed.SkippedCount)
		}
	}
	return rt.ToolNormalizerResult{
		Summary: summary, Evidence: evidence, Progress: boolPtr(len(evidence) > 0),
		Data: mustJSON(map[string]any{
			"requestedCount": parsed.RequestedCount, "readCount": len(evidence),
			"skippedCount": parsed.SkippedCount, "failureCount": len(parsed.Failures),
			"pages": pages,
		}),
		SuggestedActions: map[bool][]string{true: {}, false: {"knowledge.search"}}[len(evidence) > 0],
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func extractHits(output any) []map[string]any {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Hits []map[string]any `json:"hits"`
	}
	_ = json.Unmarshal(raw, &parsed)
	return parsed.Hits
}

func boolPtr2(v bool) *bool { return &v }

// ===== Wiki 域工具 =====

func registerWikiTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	wikiTag := []string{"wiki"}

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.wiki_overview", Name: "wiki_overview", Namespace: rt.NamespaceKnowledge,
		Description: "列出 Wiki 页面分组概览：主题与知识页（概念/实体/对比/答案）+ 源文档页，每页含 pageKey、标题与摘要。" +
			"何时用：不了解当前知识库有哪些页面时，先掌握全貌再决定读哪些页面；已经知道找什么就直接 search_wiki_pages。" +
			"输入：无；可选 knowledgeBaseId 限定库（缺省沿用当前提问范围，未指定时跨全部知识库）。" +
			"输出：分组页面目录。已知 pageKey 时可直接 read_wiki_page_detail。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"}}}`),
		RiskLevel:   rt.RiskLow, Tags: wikiTag,
		Execute: executeWikiOverview,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			raw, _ := json.Marshal(output)
			var parsed struct {
				Total  int `json:"total"`
				Groups []struct {
					Key   string           `json:"key"`
					Label string           `json:"label"`
					Pages []map[string]any `json:"pages"`
				} `json:"groups"`
			}
			_ = json.Unmarshal(raw, &parsed)
			if parsed.Total == 0 {
				return rt.ToolNormalizerResult{Summary: "当前范围内还没有可用的 Wiki 页面"}
			}
			pages := []map[string]any{}
			labels := []string{}
			for _, group := range parsed.Groups {
				for _, page := range group.Pages {
					if len(pages) < 60 {
						pages = append(pages, map[string]any{
							"pageKey": page["pageKey"], "title": page["title"],
							"kind": page["kind"], "summary": page["summary"],
						})
					}
				}
				labels = append(labels, fmt.Sprintf("%s%d", group.Label, len(group.Pages)))
			}
			data, _ := json.Marshal(map[string]any{"total": parsed.Total, "pages": pages})
			return rt.ToolNormalizerResult{
				Summary:          "Wiki 共 " + itoa(parsed.Total) + " 个页面：" + joinStrings(labels, "、"),
				Data:             data,
				SuggestedActions: []string{"search_wiki_pages", "read_wiki_page_detail"},
				Progress:         boolPtr(true),
			}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.search_wiki_pages", Name: "search_wiki_pages", Namespace: rt.NamespaceKnowledge,
		Description: "在 Wiki 页面里做多关键词检索：queries 一次传多个词（同义概念、别名词一起搜），" +
			"命中标题/摘要/别名/正文，返回 pageKey、标题、类型、别名、摘要与正文命中片段。" +
			"何时用：不知道确切 pageKey 时定位 Wiki 页面。未指定库时跨全部知识库检索。" +
			"何时不用：要浏览全貌用 wiki_overview；要正文用 read_wiki_page_detail。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"knowledgeBaseId":{"type":"string","description":"可选，限定知识库"},"queries":{"type":"array","items":{"type":"string"},"minItems":1},"limit":{"type":"integer"}},"required":["queries"]}`),
		RiskLevel:   rt.RiskLow, Tags: wikiTag,
		Execute:   executeWikiSearchPages,
		Normalize: normalizeWikiPageSearch,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "knowledge.read_wiki_page_detail", Name: "read_wiki_page_detail", Namespace: rt.NamespaceKnowledge,
		Description: "读 Wiki 页面全文（含关联页面链接与摘要），支持多跳。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"knowledgeBaseId":{"type":"string"},"pageKey":{"type":"string"}},"required":["knowledgeBaseId","pageKey"]}`),
		RiskLevel:   rt.RiskLow, Tags: wikiTag,
		Execute:   executeWikiReadPage,
		Normalize: normalizeWikiPageRead,
	})
}

func executeWikiOverview(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	kbID := parseID(params["knowledgeBaseId"])
	if kbID <= 0 {
		if id, ok := focusInt(ctx.Focus, "knowledgeBaseId"); ok {
			kbID = id
		}
	}
	// 未指定库时跨用户全部知识库（与 TS listUserWikiOverview 一致）
	return kbListWikiOverview(toolContext(ctx), ctx.UserID, kbID), nil
}

func executeWikiSearchPages(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	kbID := parseID(params["knowledgeBaseId"])
	if kbID <= 0 {
		if id, ok := focusInt(ctx.Focus, "knowledgeBaseId"); ok {
			kbID = id
		}
	}
	queriesRaw, _ := params["queries"].([]any)
	queries := make([]string, 0, len(queriesRaw))
	for _, q := range queriesRaw {
		if s, ok := q.(string); ok && trimSpace(s) != "" {
			queries = append(queries, s)
		}
	}
	if len(queries) == 0 {
		return nil, rt.ValidationError("至少提供一个搜索关键词")
	}
	limit := 8
	if v, ok := params["limit"].(float64); ok && v > 0 {
		limit = int(v)
	}
	cleaned, items := kbSearchWikiPages(toolContext(ctx), ctx.UserID, kbID, queries, limit)
	return map[string]any{"query": cleaned, "items": items}, nil
}

func executeWikiReadPage(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	kbID := parseID(params["knowledgeBaseId"])
	if kbID <= 0 {
		if id, ok := focusInt(ctx.Focus, "knowledgeBaseId"); ok {
			kbID = id
		}
	}
	pageKey, _ := params["pageKey"].(string)
	if pageKey == "" {
		return nil, rt.ValidationError("pageKey 不能为空")
	}
	detail, err := kbWikiPageDetailByPageKey(toolContext(ctx), ctx.UserID, kbID, pageKey)
	if err != nil {
		return nil, err
	}
	return detail, nil
}

func normalizeWikiPageSearch(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Query []string         `json:"query"`
		Items []map[string]any `json:"items"`
	}
	_ = json.Unmarshal(raw, &parsed)
	if len(parsed.Items) == 0 {
		return rt.ToolNormalizerResult{
			Summary:          "没有匹配的 Wiki 页面",
			Data:             mustJSON(map[string]any{"items": []any{}}),
			SuggestedActions: []string{"wiki_overview", "rewrite_query"},
		}
	}
	items := make([]map[string]any, 0, len(parsed.Items))
	for _, item := range parsed.Items {
		items = append(items, map[string]any{
			"pageKey": item["pageKey"], "title": item["title"],
			"kind": item["kind"], "aliases": item["aliases"],
			"summary": item["summary"], "snippet": item["snippet"],
		})
	}
	data := mustJSON(map[string]any{"items": items})
	return rt.ToolNormalizerResult{
		Summary:          "命中 " + itoa(len(items)) + " 个 Wiki 页面（关键词：" + joinStrings(parsed.Query, " / ") + "）",
		Data:             data,
		SuggestedActions: []string{"read_wiki_page_detail"},
		Progress:         boolPtr(true),
	}
}

func normalizeWikiPageRead(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		PageKey   string           `json:"pageKey"`
		Title     string           `json:"title"`
		Kind      string           `json:"kind"`
		Aliases   []string         `json:"aliases"`
		ContentMd string           `json:"contentMd"`
		Links     []map[string]any `json:"links"`
		InLinks   []map[string]any `json:"inLinks"`
	}
	_ = json.Unmarshal(raw, &parsed)
	title := parsed.Title
	if title == "" {
		title = parsed.PageKey
		if title == "" {
			title = "Wiki 页面"
		}
	}
	content := trimSpace(parsed.ContentMd)
	if content == "" {
		return rt.ToolNormalizerResult{
			Summary: "「" + title + "」没有可引用的正文内容",
			Data:    mustJSON(map[string]any{"pageKey": parsed.PageKey, "title": title}),
		}
	}
	neighborCount := len(parsed.Links) + len(parsed.InLinks)
	pages := make([]wikiMentionObservationPage, 0, neighborCount+1)
	pageIndex := map[string]int{}
	pages = appendWikiMentionObservationPage(pages, pageIndex, wikiMentionObservationPage{
		PageKey: parsed.PageKey, Title: title, Kind: parsed.Kind, Aliases: parsed.Aliases,
	})
	for _, neighbors := range [][]map[string]any{parsed.Links, parsed.InLinks} {
		for _, neighbor := range neighbors {
			rawNeighbor, _ := json.Marshal(neighbor)
			var page wikiMentionObservationPage
			if json.Unmarshal(rawNeighbor, &page) == nil {
				pages = appendWikiMentionObservationPage(pages, pageIndex, page)
			}
		}
	}
	// 全文读取：正文完整进证据，不在这里裁（与 TS 一致，体积由段内回传与证据预算统一兜底）
	evidenceContent := "[Wiki 页面 " + title + "]\n\n" + content
	meta := map[string]any{"kind": parsed.Kind}
	if parsed.PageKey != "" {
		meta["pageKey"] = parsed.PageKey
	}
	if len(parsed.Aliases) > 0 {
		meta["aliases"] = parsed.Aliases
	}
	return rt.ToolNormalizerResult{
		Summary: fmt.Sprintf("已读取 Wiki 页面「%s」（%d 字%s），回答时请用 [[%s|%s]] 引用",
			title, len([]rune(content)),
			map[bool]string{true: fmt.Sprintf("，%d 个关联页面", neighborCount), false: ""}[neighborCount > 0],
			parsed.PageKey, title),
		Data: mustJSON(map[string]any{
			"pageKey": parsed.PageKey, "title": title, "kind": parsed.Kind,
			"aliases": parsed.Aliases, "excerpt": truncateRunes(content, 400), "pages": pages,
		}),
		Evidence: []rt.EvidenceInput{{
			Source: rt.EvidenceWiki, Title: title, Content: evidenceContent,
			FullRead: true, SourceID: parsed.PageKey,
			Relevance: floatPtr(0.85), Confidence: floatPtr(0.85),
			Metadata: meta,
		}},
		SuggestedActions: []string{"read_wiki_page_detail"},
	}
}

// ===== agent 元工具 =====
