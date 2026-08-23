// docs.go 对照 handlers.ts：document/search、tree、semantic-search、view、qa 端点。
package agentapi

import (
	"context"
	"regexp"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgxpool"

	"petrichor/api/internal/kb"
)

// AgentSearchDocuments POST /api/agent/document/search（scope doc:read）。
func AgentSearchDocuments(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "doc:read"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	kbID, hasKB, err := optID(raw, "knowledgeBaseId")
	if err != nil {
		return nil, err
	}
	query := trimmedString(raw, "query")
	if query == "" || len([]rune(query)) > 200 {
		return nil, badReq("query 必须在 1 到 200 个字符之间")
	}
	limit := coerceLimit(raw["limit"], 8, 1, 20)

	var kbFilter *int64
	if hasKB {
		kbFilter = &kbID
	}
	items, err := searchAgentDocuments(dbPool(), actx.UserID, kbFilter, query, limit)
	if err != nil {
		return nil, err
	}
	maps := make([]map[string]any, 0, len(items))
	for i := range items {
		maps = append(maps, items[i].toCitationMap())
	}
	return map[string]any{"items": maps}, nil
}

// AgentRetrieveDocumentTree POST /api/agent/document/tree（scope doc:read）。
func AgentRetrieveDocumentTree(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "doc:read"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	query := trimmedString(raw, "query")
	if query == "" || len([]rune(query)) > 200 {
		return nil, badReq("query 必须在 1 到 200 个字符之间")
	}
	limit := coerceLimit(raw["limit"], 6, 1, 12)
	articleID, hasArticle, err := optID(raw, "articleId")
	if err != nil {
		return nil, err
	}
	var articleFilter *int64
	if hasArticle {
		articleFilter = &articleID
	}
	items, err := retrieveTreeNodesForAgentCore(dbPool(), actx.UserID, kbID, query, limit, articleFilter)
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": items}, nil
}

// AgentSemanticSearchDocumentTree POST /api/agent/document/semantic-search（scope doc:read）。
func AgentSemanticSearchDocumentTree(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "doc:read"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
	if err != nil {
		return nil, err
	}
	query := trimmedString(raw, "query")
	if query == "" || len([]rune(query)) > 200 {
		return nil, badReq("query 必须在 1 到 200 个字符之间")
	}
	limit := coerceLimit(raw["limit"], 6, 1, 12)
	articleID, hasArticle, err := optID(raw, "articleId")
	if err != nil {
		return nil, err
	}
	var articleFilter *int64
	if hasArticle {
		articleFilter = &articleID
	}
	items, err := semanticSearchTreeNodesCore(dbPool(), actx.UserID, kbID, query, limit, articleFilter)
	if err != nil {
		return nil, err
	}
	return map[string]any{"items": items}, nil
}

type mediaReference struct {
	id                 string
	kind               string // image | video | audio | file
	alt                string
	src                string
	objectKey          *string
	filename           string
	sourceArticleID    *string
	sourceArticleTitle *string
}

func (m *mediaReference) toMap() map[string]any {
	return map[string]any{
		"id":                 m.id,
		"kind":               m.kind,
		"alt":                m.alt,
		"src":                m.src,
		"objectKey":          m.objectKey,
		"filename":           m.filename,
		"sourceArticleId":    m.sourceArticleID,
		"sourceArticleTitle": m.sourceArticleTitle,
	}
}

var mediaExtensionRules = []struct {
	kind string
	re   *regexp.Regexp
}{
	{"image", regexp.MustCompile(`(?i)\.(?:png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#].*)?$`)},
	{"video", regexp.MustCompile(`(?i)\.(?:mp4|webm|ogv|mov|m4v|mkv)(?:[?#].*)?$`)},
	{"audio", regexp.MustCompile(`(?i)\.(?:mp3|wav|m4a|aac|flac|ogg|oga)(?:[?#].*)?$`)},
	{"file", regexp.MustCompile(`(?i)\.(?:pdf|docx?|pptx?|xlsx?|csv|txt|md|zip|rar|7z|json)(?:[?#].*)?$`)},
}

func classifyMediaExtension(path string) string {
	for _, rule := range mediaExtensionRules {
		if rule.re.MatchString(path) {
			return rule.kind
		}
	}
	return ""
}

var storageObjectKeyRe = regexp.MustCompile(`(?i)^/?uploads/\d+/.+$`)

// normalizeAgentMediaSource 简化版媒体来源识别：
// s4key:/uploads/<id>/<对象> 视为存储对象；http(s)/data:image 外链按扩展名归类。
// 偏差：未移植 TS 的 HTML 标签扫描（<img>/<video>/<file>），仅覆盖 Markdown 图片/链接与裸存储路径。
func normalizeAgentMediaSource(rawSrc string) (src, objectKey, filename, kind string, ok bool) {
	src = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(rawSrc, "<"), ">"))
	src = strings.Trim(src, ">")
	if src == "" {
		return "", "", "", "", false
	}
	candidate := strings.TrimPrefix(src, "s4key:")
	withoutSlash := strings.TrimLeft(candidate, "/")
	objectPath := withoutSlash
	if idx := strings.IndexAny(objectPath, "?#"); idx >= 0 {
		objectPath = objectPath[:idx]
	}
	if storageObjectKeyRe.MatchString(objectPath) {
		key := objectPath
		kind = classifyMediaExtension(key)
		if kind == "" {
			kind = "file"
		}
		return "s4key:" + key, key, extractMediaFilename(key), kind, true
	}
	if strings.HasPrefix(src, "data:image/") {
		return src, "", extractMediaFilename(src), "image", true
	}
	if strings.HasPrefix(strings.ToLower(src), "http://") || strings.HasPrefix(strings.ToLower(src), "https://") {
		pathOnly := src
		if idx := strings.IndexAny(pathOnly, "?#"); idx >= 0 {
			pathOnly = pathOnly[:idx]
		}
		kind = classifyMediaExtension(pathOnly)
		if kind == "" {
			return "", "", "", "", false
		}
		return src, "", extractMediaFilename(src), kind, true
	}
	return "", "", "", "", false
}

func extractMediaFilename(src string) string {
	clean := src
	if idx := strings.IndexAny(clean, "?#"); idx >= 0 {
		clean = clean[:idx]
	}
	parts := strings.Split(clean, "/")
	part := ""
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] != "" {
			part = parts[i]
			break
		}
	}
	if part == "" {
		return "附件"
	}
	return part
}

const maxMediaRefs = 20

// extractAgentImageReferences 从 Markdown 提取图片/附件引用（去重，最多 20 条）。
func extractAgentImageReferences(markdown string) []mediaReference {
	if strings.TrimSpace(markdown) == "" {
		return nil
	}
	counters := map[string]int{}
	seen := map[string]struct{}{}
	var refs []mediaReference
	addRef := func(rawSrc, label string) {
		src, objectKey, filename, kind, valid := normalizeAgentMediaSource(rawSrc)
		if !valid {
			return
		}
		dedupeKey := objectKey
		if dedupeKey == "" {
			dedupeKey = src
		}
		if _, dup := seen[dedupeKey]; dup {
			return
		}
		seen[dedupeKey] = struct{}{}
		counters[kind]++
		alt := strings.TrimSpace(label)
		if alt == "" {
			alt = filename
		}
		if alt == "" {
			switch kind {
			case "image":
				alt = "图片"
			case "video":
				alt = "视频"
			case "audio":
				alt = "音频"
			default:
				alt = "附件"
			}
		}
		var keyPtr *string
		if objectKey != "" {
			keyPtr = &objectKey
		}
		refs = append(refs, mediaReference{
			id:        kind + "-" + strconv.Itoa(counters[kind]),
			kind:      kind,
			alt:       alt,
			src:       src,
			objectKey: keyPtr,
			filename:  filename,
		})
	}
	for _, match := range markdownLinkOrImageRe.FindAllStringSubmatch(markdown, -1) {
		if match[1] != "!" {
			continue
		}
		addRef(match[3], match[2])
	}
	for _, match := range markdownLinkOrImageRe.FindAllStringSubmatch(markdown, -1) {
		if match[1] == "!" {
			continue // 图片语法已单独处理
		}
		addRef(match[3], match[2])
	}
	for _, match := range rawStorageMediaRe.FindAllString(markdown, -1) {
		addRef(match, "")
	}
	if len(refs) > maxMediaRefs {
		refs = refs[:maxMediaRefs]
	}
	return refs
}

// Go regexp（RE2）不支持负向后行断言：用可选 ! 前缀统一匹配，链接遍历时跳过图片。
var (
	markdownLinkOrImageRe = regexp.MustCompile(`(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)`)
	rawStorageMediaRe     = regexp.MustCompile(`(?:s4key:)?/?uploads/\d+/[^\s"'<>()[\]{}]+?\.[A-Za-z0-9]{1,12}(?:[?#][^\s"'<>()[\]{}]*)?`)
)

// AgentViewDocument POST /api/agent/document/view（scope doc:read）。
func AgentViewDocument(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "doc:read"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	articleID, hasArticle, err := optID(raw, "articleId")
	if err != nil {
		return nil, err
	}
	kbID, hasKB, err := optID(raw, "knowledgeBaseId")
	if err != nil {
		return nil, err
	}
	pageKey := trimmedString(raw, "pageKey")
	if !hasArticle && !(hasKB && pageKey != "") {
		return nil, badReq("必须提供 articleId，或同时提供 knowledgeBaseId 与 pageKey")
	}
	if len([]rune(pageKey)) > 200 {
		return nil, badReq("pageKey 长度不能超过 200")
	}

	q := dbPool()
	if hasArticle {
		full, err := kb.QueryOwnedArticleForAgent(q, actx.UserID, articleID)
		if err != nil {
			return nil, err
		}
		if full == nil {
			return nil, notFoundErr("文章不存在")
		}
		tags, terr := loadTags(q, full.ID)
		if terr != nil {
			return nil, terr
		}
		return map[string]any{
			"type":            "article",
			"articleId":       idStr(full.ID),
			"knowledgeBaseId": idStr(full.KnowledgeBaseID),
			"nodeId":          idStr(full.NodeID),
			"title":           full.Title,
			"contentMd":       full.ContentMd,
			"tags":            tags,
			"createdAt":       iso(full.CreatedAt),
			"updatedAt":       iso(full.UpdatedAt),
		}, nil
	}

	// Wiki 页面分支（对照 readWikiPageForAgent）。
	detail, err := kb.LoadWikiPageDetailForAgent(q, actx.UserID, kbID, pageKey)
	if err != nil {
		return nil, err
	}
	pageKeyValue, _ := detail["pageKey"].(string)
	contentMd, _ := detail["contentMd"].(string)
	sourceRefs, _ := detail["sourceRefs"].([]map[string]any)

	mediaMaps := extractWikiPageMedia(actx.UserID, kbID, contentMd, sourceRefs)
	links, _ := detail["links"]
	return map[string]any{
		"type":            "wiki",
		"knowledgeBaseId": idStr(kbID),
		"pageKey":         pageKeyValue,
		"articleId":       optionalValue(extractArticleIDFromSourceKey(pageKeyValue)),
		"title":           detail["title"],
		"kind":            detail["kind"],
		"contentMd":       contentMd,
		"media":           mediaMaps,
		"sourceRefs":      sourceRefs,
		"links":           links,
	}, nil
}

func optionalValue(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// extractWikiPageMedia 页面正文 + 来源文章正文的媒体引用合并（对照 mergeAgentImageReferences）。
func extractWikiPageMedia(userID, kbID int64, pageContentMd string, sourceRefs []map[string]any) []map[string]any {
	type mediaWithSource struct {
		ref          mediaReference
		articleID    *string
		articleTitle *string
	}
	var merged []mediaWithSource
	seen := map[string]struct{}{}
	appendRefs := func(contentMd string, articleID, articleTitle *string) {
		for _, ref := range extractAgentImageReferences(contentMd) {
			key := deref(ref.objectKey)
			if key == "" {
				key = ref.src
			}
			if _, dup := seen[key]; dup {
				continue
			}
			seen[key] = struct{}{}
			merged = append(merged, mediaWithSource{ref: ref, articleID: articleID, articleTitle: articleTitle})
		}
	}
	appendRefs(pageContentMd, nil, nil)

	// 来源文章正文中的图片补充（对照 loadArticleImageReferences，上限 10 篇）。
	collected := 0
	q := dbPool()
	for _, ref := range sourceRefs {
		if collected >= 10 {
			break
		}
		articleIDText, _ := ref["articleId"].(string)
		if articleIDText == "" {
			continue
		}
		rows, err := q.Query(context.Background(),
			`SELECT id, title, content_md FROM petrichor_kb_article
			 WHERE user_id = $1 AND knowledge_base_id = $2 AND id = $3 LIMIT 1`,
			userID, kbID, parseIDOrZero(articleIDText))
		if err != nil {
			continue
		}
		for rows.Next() {
			var id int64
			var title, contentMd string
			if err := rows.Scan(&id, &title, &contentMd); err == nil {
				aID := idStr(id)
				t := title
				appendRefs(contentMd, &aID, &t)
				collected++
			}
		}
		rows.Close()
	}

	// 按类型重新分配 id（对照 makeMediaIdAssigner）。
	counters := map[string]int{}
	out := make([]map[string]any, 0, len(merged))
	for i := range merged {
		item := &merged[i]
		counters[item.ref.kind]++
		item.ref.id = item.ref.kind + "-" + strconv.Itoa(counters[item.ref.kind])
		if len(out) >= maxMediaRefs {
			break
		}
		m := item.ref.toMap()
		m["id"] = item.ref.id
		m["sourceArticleId"] = item.articleID
		m["sourceArticleTitle"] = item.articleTitle
		out = append(out, m)
	}
	return out
}

func parseIDOrZero(s string) int64 {
	n := int64(0)
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0
		}
		n = n*10 + int64(s[i]-'0')
	}
	return n
}

// ===== document/qa =====

// AgentAskDocument POST /api/agent/document/qa（scope qa:read，走 ChatInvoker）。
func AgentAskDocument(c *gin.Context, actx *authContext) (any, error) {
	if err := requireAgentScope(actx, "qa:read"); err != nil {
		return nil, err
	}
	raw, err := readBodyMap(c)
	if err != nil {
		return nil, err
	}
	kbID, hasKB, err := optID(raw, "knowledgeBaseId")
	if err != nil {
		return nil, err
	}
	question := trimmedString(raw, "question")
	if question == "" || len([]rune(question)) > 1000 {
		return nil, badReq("question 必须在 1 到 1000 个字符之间")
	}
	limit := coerceLimit(raw["limit"], 6, 1, 10)

	var kbFilter *int64
	if hasKB {
		kbFilter = &kbID
	}
	hits, err := searchAgentDocuments(dbPool(), actx.UserID, kbFilter, question, limit)
	if err != nil {
		return nil, err
	}

	// 加载上下文正文（chunk → 分片原文，wiki → 页面正文，tree/article → 文章正文）。
	type contextItem struct {
		hit       documentHit
		contentMd string
	}
	contexts := []contextItem{}
	q := dbPool()
	for i := range hits {
		hit := &hits[i]
		switch {
		case hit.hitType == "chunk" && hit.chunkID != nil:
			chunkContent, cerr := readChunkContent(q, actx.UserID, parseIDOrZero(hit.knowledgeBaseID), parseIDOrZero(*hit.chunkID))
			if cerr != nil {
				continue
			}
			contexts = append(contexts, contextItem{hit: *hit, contentMd: chunkContent})
		case hit.hitType == "wiki" && hit.pageKey != nil:
			detail, derr := kb.LoadWikiPageDetailForAgent(q, actx.UserID, parseIDOrZero(hit.knowledgeBaseID), *hit.pageKey)
			if derr != nil {
				continue
			}
			content, _ := detail["contentMd"].(string)
			contexts = append(contexts, contextItem{hit: *hit, contentMd: content})
		case hit.articleID != nil:
			full, aerr := kb.QueryOwnedArticleForAgent(q, actx.UserID, parseIDOrZero(*hit.articleID))
			if aerr != nil || full == nil {
				continue
			}
			contexts = append(contexts, contextItem{hit: *hit, contentMd: full.ContentMd})
		}
	}

	if len(contexts) == 0 {
		return map[string]any{
			"answer":    "未找到足够的文档依据回答这个问题。",
			"citations": []any{},
			"usage":     nil,
			"modelName": nil,
		}, nil
	}

	systemPrompt := strings.Join([]string{
		"你是 Petrichor 的外部文档问答接口。",
		"只基于用户提供的文档上下文回答。",
		"如果上下文不足，明确说明无法从现有文档确认。",
		"用中文回答，保持简洁，并在答案末尾列出依据标题。",
	}, "\n")

	var parts []string
	for index := range contexts {
		item := &contexts[index]
		lines := []string{
			"## 文档 " + strconv.Itoa(index+1) + ": " + item.hit.title,
			"类型：" + documentTypeLabel(item.hit.hitType),
			"知识库 ID：" + item.hit.knowledgeBaseID,
		}
		if item.hit.articleID != nil {
			lines = append(lines, "文章 ID："+*item.hit.articleID)
		}
		if item.hit.chunkID != nil {
			lines = append(lines, "分片 ID："+*item.hit.chunkID)
		}
		if item.hit.pageKey != nil {
			lines = append(lines, "页面 Key："+*item.hit.pageKey)
		}
		lines = append(lines, "", truncateQAText(item.contentMd, 6000))
		parts = append(parts, strings.Join(filterEmpty(lines), "\n"))
	}
	message := strings.Join([]string{
		"问题：" + question,
		"",
		"文档上下文：",
		strings.Join(parts, "\n\n---\n\n"),
	}, "\n")

	answer, err := kb.ChatInvoker(context.Background(), kb.ChatRequest{
		UserID:       actx.UserID,
		SystemPrompt: systemPrompt,
		Message:      message,
		Op:           "kb.doc.qa",
	})
	if err != nil {
		return nil, err
	}

	citations := make([]map[string]any, 0, len(contexts))
	for i := range contexts {
		citations = append(citations, contexts[i].hit.toCitationMap())
	}
	return map[string]any{
		"answer":    answer,
		"citations": citations,
		"modelName": nil,
		"reasoning": nil,
		"usage":     nil,
	}, nil
}

func documentTypeLabel(t string) string {
	switch t {
	case "wiki":
		return "Wiki 页面"
	case "chunk":
		return "原始分片"
	default:
		return "源文章"
	}
}

func truncateQAText(value string, maxLength int) string {
	text := strings.TrimSpace(value)
	runes := []rune(text)
	if len(runes) <= maxLength {
		return text
	}
	return string(runes[:maxLength-1]) + "…"
}

func filterEmpty(lines []string) []string {
	out := lines[:0]
	for _, line := range lines {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}

// readChunkContent 对照 article-knowledge-index.ts readArticleKnowledgeChunkForAgent（仅取正文）。
func readChunkContent(q *pgxpool.Pool, userID, knowledgeBaseID, chunkID int64) (string, error) {
	var contentMd string
	err := q.QueryRow(context.Background(),
		`SELECT c.content_md FROM petrichor_kb_article_chunk c
		 JOIN petrichor_kb_article a ON a.id = c.article_id
		 WHERE c.id = $1 AND c.user_id = $2 AND c.knowledge_base_id = $3 AND a.user_id = $2 LIMIT 1`,
		chunkID, userID, knowledgeBaseID).Scan(&contentMd)
	if err != nil {
		return "", err
	}
	return contentMd, nil
}

func coerceLimit(raw any, def, minV, maxV int) int {
	v, ok := raw.(float64)
	if !ok || v != float64(int64(v)) || int64(v) < int64(minV) || int64(v) > int64(maxV) {
		return def
	}
	return int(v)
}
