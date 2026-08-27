package assistantsvc

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

const (
	documentSearchSchema = `{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":500},"libraryId":{"type":["string","integer"]},"documentId":{"type":["string","integer"]},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["query"]}`
	documentReadSchema   = `{"type":"object","properties":{"documentId":{"type":["string","integer"]},"fromIndex":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":40}}}`
	documentExportSchema = `{"type":"object","properties":{"knowledgeBaseId":{"type":["string","integer"]},"articleId":{"type":["string","integer"]},"format":{"type":"string","enum":["markdown","outline"]},"includeFrontMatter":{"type":"boolean"}},"required":["articleId"]}`
)

var unsafeFileName = regexp.MustCompile(`[\\/:*?"<>|\s]+`)

func registerDocumentTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registerDocumentWriteTools(registry)

	registry.Register(&rt.AgentToolDefinition{
		ID: "document.list_libraries", Name: "list_doc_libraries", Namespace: rt.NamespaceDocument,
		Description: "列出当前用户拥有的文档库，用于选择原始文件检索范围。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`), RiskLevel: rt.RiskLow,
		Execute: executeDocumentListLibraries,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			raw, _ := json.Marshal(output)
			var parsed struct {
				Libraries []map[string]any `json:"libraries"`
			}
			_ = json.Unmarshal(raw, &parsed)
			return rt.ToolNormalizerResult{Summary: fmt.Sprintf("找到 %d 个文档库", len(parsed.Libraries)), Data: mustJSON(output), Progress: boolPtr(len(parsed.Libraries) > 0)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "document.search", Name: "search_documents", Namespace: rt.NamespaceDocument,
		Description: "按关键词检索文档文本片段；可用 libraryId/documentId 限定，未指定时沿用当前 focus。",
		InputSchema: schemaJSON(documentSearchSchema), RiskLevel: rt.RiskLow,
		Execute:   executeDocumentSearch,
		Normalize: normalizeDocumentSearch,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "document.read", Name: "read_document", Namespace: rt.NamespaceDocument,
		Description: "顺序读取文档文本片段；支持 fromIndex/limit 翻页，documentId 可沿用当前 focus。",
		InputSchema: schemaJSON(documentReadSchema), RiskLevel: rt.RiskLow,
		Execute:   executeDocumentRead,
		Normalize: normalizeDocumentRead,
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "document.export", Name: "export_document", Namespace: rt.NamespaceDocument,
		Description: "把一篇知识库文章导出为完整 Markdown 或章节提纲；只需要片段时不要整篇导出。",
		InputSchema: schemaJSON(documentExportSchema), RiskLevel: rt.RiskLow,
		AllowedInSubAgent: toolPtr(false), Execute: executeDocumentExport,
		Normalize: normalizeDocumentExport,
	})
}

func executeDocumentListLibraries(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	rows, err := dbPool().Query(toolContext(ctx), `
		SELECT id, name, COALESCE(description,''), document_count
		FROM petrichor_doc_library WHERE user_id=$1
		ORDER BY updated_at DESC, id DESC`, ctx.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	libraries := []map[string]any{}
	for rows.Next() {
		var id, count int64
		var name, description string
		if rows.Scan(&id, &name, &description, &count) != nil {
			continue
		}
		libraries = append(libraries, map[string]any{
			"id": idStr(id), "name": name, "description": description, "documentCount": count,
		})
	}
	return map[string]any{"libraries": libraries}, rows.Err()
}

func resolveDocumentScope(ctx *rt.ToolExecutionContext, params map[string]any) (int64, int64) {
	libraryID := parseID(params["libraryId"])
	documentID := parseID(params["documentId"])
	if libraryID == 0 && documentID == 0 {
		libraryID, _ = focusInt(ctx.Focus, "libraryId")
		documentID, _ = focusInt(ctx.Focus, "documentId")
	}
	return libraryID, documentID
}

func executeDocumentSearch(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	query := strings.TrimSpace(stringValue(params["query"]))
	if query == "" {
		return nil, rt.ValidationError("query 不能为空")
	}
	libraryID, documentID := resolveDocumentScope(ctx, params)
	limit := intValue(params["limit"])
	if limit <= 0 || limit > 20 {
		limit = 8
	}
	patterns := likePatterns(buildQueryTokens(query))
	if len(patterns) == 0 {
		patterns = []string{"%" + sanitizeLike(query) + "%"}
	}
	rows, err := dbPool().Query(toolContext(ctx), `
		SELECT c.id, c.document_id, c.library_id, c.page, c.locator,
		       substring(c.text from 1 for 600), d.title, d.file_name, d.file_type,
		       word_similarity($3, c.text)::float8 AS score
		FROM petrichor_doc_chunk c
		JOIN petrichor_doc_document d ON d.id=c.document_id AND d.user_id=c.user_id
		WHERE c.user_id=$1 AND c.text ILIKE ANY($2)
		  AND ($4::bigint=0 OR c.library_id=$4)
		  AND ($5::bigint=0 OR c.document_id=$5)
		ORDER BY score DESC, c.chunk_index ASC LIMIT $6`,
		ctx.UserID, patterns, query, libraryID, documentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []map[string]any{}
	for rows.Next() {
		var chunkID, gotDocumentID, gotLibraryID int64
		var page *int32
		var locator *string
		var snippet, title, fileName, fileType string
		var score float64
		if rows.Scan(&chunkID, &gotDocumentID, &gotLibraryID, &page, &locator,
			&snippet, &title, &fileName, &fileType, &score) != nil {
			continue
		}
		location := ""
		if locator != nil {
			location = *locator
		} else if page != nil {
			location = fmt.Sprintf("p.%d", *page)
		}
		hits = append(hits, map[string]any{
			"chunkId": idStr(chunkID), "documentId": idStr(gotDocumentID), "libraryId": idStr(gotLibraryID),
			"href":  fmt.Sprintf("/dashboard/doc-library/%d?documentId=%d", gotLibraryID, gotDocumentID),
			"title": title, "fileName": fileName, "fileType": fileType,
			"locator": location, "page": page, "snippet": snippet, "score": score,
		})
	}
	return map[string]any{"hits": hits, "query": query}, rows.Err()
}

func normalizeDocumentSearch(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Hits []map[string]any `json:"hits"`
	}
	_ = json.Unmarshal(raw, &parsed)
	if len(parsed.Hits) == 0 {
		return rt.ToolNormalizerResult{Summary: "文档库中未检索到相关内容", Data: mustJSON(map[string]any{"hits": parsed.Hits}), SuggestedActions: []string{"rewrite_query", "knowledge.search"}, Progress: boolPtr(false)}
	}
	return rt.ToolNormalizerResult{
		Summary: fmt.Sprintf("文档库中找到 %d 个片段", len(parsed.Hits)),
		Data:    mustJSON(map[string]any{"hits": parsed.Hits}), SuggestedActions: []string{"document.read"}, Progress: boolPtr(true),
	}
}

func executeDocumentRead(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	documentID := parseID(params["documentId"])
	if documentID == 0 {
		documentID, _ = focusInt(ctx.Focus, "documentId")
	}
	if documentID <= 0 {
		return nil, rt.ValidationError("缺少 documentId，且当前对话未提供 focus.documentId")
	}
	from := intValue(params["fromIndex"])
	if from < 0 {
		from = 0
	}
	limit := intValue(params["limit"])
	if limit <= 0 || limit > 40 {
		limit = 12
	}
	var libraryID int64
	var title, fileName, fileType string
	if err := dbPool().QueryRow(toolContext(ctx), `
		SELECT library_id, title, file_name, file_type
		FROM petrichor_doc_document WHERE id=$1 AND user_id=$2 LIMIT 1`,
		documentID, ctx.UserID).Scan(&libraryID, &title, &fileName, &fileType); err != nil {
		return nil, rt.ValidationError("文档不存在或不属于当前用户")
	}
	rows, err := dbPool().Query(toolContext(ctx), `
		SELECT chunk_index, page, locator, text FROM petrichor_doc_chunk
		WHERE document_id=$1 AND user_id=$2 ORDER BY chunk_index ASC LIMIT $3 OFFSET $4`,
		documentID, ctx.UserID, limit, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	chunks := []map[string]any{}
	for rows.Next() {
		var chunkIndex int
		var page *int32
		var locator *string
		var text string
		if rows.Scan(&chunkIndex, &page, &locator, &text) != nil {
			continue
		}
		location := ""
		if locator != nil {
			location = *locator
		} else if page != nil {
			location = fmt.Sprintf("p.%d", *page)
		}
		chunks = append(chunks, map[string]any{
			"chunkIndex": chunkIndex, "locator": location, "page": page, "text": text,
		})
	}
	return map[string]any{
		"documentId": idStr(documentID), "libraryId": idStr(libraryID),
		"href":  fmt.Sprintf("/dashboard/doc-library/%d?documentId=%d", libraryID, documentID),
		"title": title, "fileName": fileName, "fileType": fileType,
		"fromIndex": from, "chunks": chunks,
	}, rows.Err()
}

func normalizeDocumentRead(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		DocumentID string `json:"documentId"`
		LibraryID  string `json:"libraryId"`
		Href       string `json:"href"`
		Title      string `json:"title"`
		Chunks     []struct {
			ChunkIndex int    `json:"chunkIndex"`
			Locator    string `json:"locator"`
			Text       string `json:"text"`
		} `json:"chunks"`
	}
	_ = json.Unmarshal(raw, &parsed)
	blocks := make([]string, 0, len(parsed.Chunks))
	for _, chunk := range parsed.Chunks {
		label := chunk.Locator
		if label == "" {
			label = fmt.Sprintf("chunk %d", chunk.ChunkIndex)
		}
		blocks = append(blocks, "["+label+"]\n"+chunk.Text)
	}
	content := strings.TrimSpace(strings.Join(blocks, "\n\n"))
	if content == "" {
		return rt.ToolNormalizerResult{Summary: "文档没有可读内容", Data: mustJSON(map[string]any{"documentId": parsed.DocumentID}), Progress: boolPtr(false)}
	}
	return rt.ToolNormalizerResult{
		Summary: fmt.Sprintf("已读取文档「%s」（%d 个片段，%d 字）", parsed.Title, len(parsed.Chunks), len([]rune(content))),
		Data:    mustJSON(map[string]any{"title": parsed.Title, "documentId": parsed.DocumentID, "libraryId": parsed.LibraryID, "excerpt": truncateRunes(content, 400)}),
		Evidence: []rt.EvidenceInput{{
			Source: rt.EvidenceKnowledge, Title: parsed.Title, Content: truncateRunes(content, 6000),
			SourceID: parsed.DocumentID, URL: parsed.Href, Relevance: floatPtr(0.75), Confidence: floatPtr(0.8),
			Metadata: map[string]any{"kind": "doc_library", "documentId": parsed.DocumentID, "libraryId": parsed.LibraryID},
		}}, Progress: boolPtr(true),
	}
}

func executeDocumentExport(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	articleID := parseID(params["articleId"])
	kbID := parseID(params["knowledgeBaseId"])
	if kbID == 0 {
		kbID, _ = focusInt(ctx.Focus, "knowledgeBaseId")
	}
	if articleID <= 0 || kbID <= 0 {
		return nil, rt.ValidationError("articleId 与 knowledgeBaseId 必须是正整数；knowledgeBaseId 可来自当前 focus")
	}
	var title, content string
	var updatedAt any
	if err := dbPool().QueryRow(toolContext(ctx), `
		SELECT title, content_md, updated_at FROM petrichor_kb_article
		WHERE id=$1 AND knowledge_base_id=$2 AND user_id=$3 LIMIT 1`, articleID, kbID, ctx.UserID).
		Scan(&title, &content, &updatedAt); err != nil {
		return nil, rt.ValidationError("文章不存在或不属于当前用户")
	}
	format := stringValue(params["format"])
	if format == "" {
		format = "markdown"
	}
	if format == "outline" {
		rows, err := dbPool().Query(toolContext(ctx), `
			SELECT depth, title FROM petrichor_kb_wiki_tree_node
			WHERE user_id=$1 AND knowledge_base_id=$2 AND article_id=$3
			ORDER BY depth ASC, position ASC, id ASC`, ctx.UserID, kbID, articleID)
		if err != nil {
			return nil, err
		}
		lines := []string{}
		for rows.Next() {
			var depth int
			var nodeTitle string
			if rows.Scan(&depth, &nodeTitle) == nil {
				if depth < 0 {
					depth = 0
				}
				if depth > 5 {
					depth = 5
				}
				lines = append(lines, strings.Repeat("#", depth+2)+" "+nodeTitle)
			}
		}
		rows.Close()
		content = strings.Join(lines, "\n")
	}
	includeFrontMatter, exists := params["includeFrontMatter"].(bool)
	if !exists || includeFrontMatter {
		content = "# " + title + "\n\n" + content
	}
	fileName := strings.Trim(unsafeFileName.ReplaceAllString(title, "-"), "-")
	if fileName == "" {
		fileName = "document"
	}
	fileName = truncateRunes(fileName, 80)
	if format == "outline" {
		fileName += "-outline"
	}
	return map[string]any{
		"format": format, "title": title, "articleId": idStr(articleID), "knowledgeBaseId": idStr(kbID),
		"href":    fmt.Sprintf("/dashboard/knowledge/%d/articles/%d", kbID, articleID),
		"content": strings.TrimSpace(content), "fileName": fileName + ".md", "updatedAt": updatedAt,
	}, nil
}

func normalizeDocumentExport(output any, _ any) rt.ToolNormalizerResult {
	raw, _ := json.Marshal(output)
	var parsed struct {
		Format          string `json:"format"`
		Title           string `json:"title"`
		ArticleID       string `json:"articleId"`
		KnowledgeBaseID string `json:"knowledgeBaseId"`
		Href            string `json:"href"`
		Content         string `json:"content"`
		FileName        string `json:"fileName"`
	}
	_ = json.Unmarshal(raw, &parsed)
	if strings.TrimSpace(parsed.Content) == "" {
		return rt.ToolNormalizerResult{Summary: "导出内容为空", SuggestedActions: []string{"knowledge.read"}, Progress: boolPtr(false)}
	}
	return rt.ToolNormalizerResult{
		Summary: fmt.Sprintf("已导出「%s」（%s，%d 字）", parsed.Title, parsed.Format, len([]rune(parsed.Content))),
		Data:    mustJSON(map[string]any{"fileName": parsed.FileName, "content": parsed.Content}),
		Evidence: []rt.EvidenceInput{{
			Source: rt.EvidenceKnowledge, Title: parsed.Title, Content: truncateRunes(parsed.Content, 4000),
			SourceID: parsed.ArticleID, URL: parsed.Href, Relevance: floatPtr(0.7), Confidence: floatPtr(0.9),
			Metadata: map[string]any{"articleId": parsed.ArticleID, "knowledgeBaseId": parsed.KnowledgeBaseID, "exported": true},
		}}, Progress: boolPtr(true),
	}
}
