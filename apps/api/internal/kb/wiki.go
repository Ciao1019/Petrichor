package kb

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikidocumentref"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikilink"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

// WikiPageList 返回知识库内由文件生成的 Wiki 页面。
func (h *Handler) WikiPageList(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
		Kind            string `json:"kind"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	pages, err := h.svc.listWikiPages(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	if kind := strings.TrimSpace(req.Kind); kind != "" {
		filtered := make([]gin.H, 0, len(pages))
		for _, page := range pages {
			if page["kind"] == kind {
				filtered = append(filtered, page)
			}
		}
		pages = filtered
	}
	response.OK(c, gin.H{"knowledgeBaseId": fmt.Sprintf("%d", kbID), "pages": pages})
}

// WikiPageDetail 返回 Wiki 正文、文件分片来源和页面出链。
func (h *Handler) WikiPageDetail(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
		PageKey         string `json:"pageKey"`
		PageID          string `json:"pageId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	q := h.svc.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(u.ID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
	)
	if strings.TrimSpace(req.PageID) != "" {
		pageID, parseErr := parsePositiveID(req.PageID, "pageId")
		if parseErr != nil {
			response.Fail(c, parseErr)
			return
		}
		q = q.Where(kbwikipage.IDEQ(pageID))
	} else if strings.TrimSpace(req.PageKey) != "" {
		q = q.Where(kbwikipage.PageKeyEQ(normalizeWikiPageKey(req.PageKey)))
	} else {
		response.Fail(c, response.BadRequest("缺少 pageKey 或 pageId"))
		return
	}
	row, err := q.Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("Wiki 页面不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	detail, err := h.svc.loadWikiPageDetail(c.Request.Context(), u.ID, row)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, detail)
}

// WikiLint 检查文件 Wiki 的来源完整性、断链和孤立页面。
func (h *Handler) WikiLint(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parsePositiveID(req.KnowledgeBaseID, "knowledgeBaseId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	lint, err := h.svc.RunWikiLintForAgent(c.Request.Context(), u.ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, lint)
}

func (s *Service) listWikiPages(ctx context.Context, userID, kbID int64) ([]gin.H, error) {
	rows, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
	).Order(ent.Asc(kbwikipage.FieldSortOrder), ent.Asc(kbwikipage.FieldKind), ent.Asc(kbwikipage.FieldTitle)).All(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		out = append(out, toWikiPageDTO(row))
	}
	return out, nil
}

// ListWikiPagesForAgent 返回与后台页面列表一致的 DTO。
func (s *Service) ListWikiPagesForAgent(ctx context.Context, userID, kbID int64) ([]gin.H, error) {
	if err := s.assertKBOwner(ctx, userID, kbID); err != nil {
		return nil, err
	}
	return s.listWikiPages(ctx, userID, kbID)
}

// LoadWikiPageDetailForAgent 返回文件 Wiki 的正文、文件来源和页面出链。
func (s *Service) LoadWikiPageDetailForAgent(ctx context.Context, userID, kbID int64, pageKey string) (gin.H, error) {
	if err := s.assertKBOwner(ctx, userID, kbID); err != nil {
		return nil, err
	}
	row, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID),
		kbwikipage.PageKeyEQ(normalizeWikiPageKey(pageKey)), kbwikipage.ArchivedAtIsNil(),
	).Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("Wiki 页面不存在")
		}
		return nil, err
	}
	return s.loadWikiPageDetail(ctx, userID, row)
}

func (s *Service) loadWikiPageDetail(ctx context.Context, userID int64, row *ent.KBWikiPage) (gin.H, error) {
	refs, err := s.client.KBWikiDocumentRef.Query().Where(
		kbwikidocumentref.PageIDEQ(row.ID),
	).Order(ent.Asc(kbwikidocumentref.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	documentIDs := make([]int64, 0, len(refs))
	for _, ref := range refs {
		documentIDs = append(documentIDs, ref.DocumentID)
	}
	documents := make(map[int64]*ent.KBDocument, len(documentIDs))
	if len(documentIDs) > 0 {
		rows, loadErr := s.client.KBDocument.Query().Where(
			kbdocument.UserIDEQ(userID), kbdocument.IDIn(documentIDs...),
		).All(ctx)
		if loadErr != nil {
			return nil, loadErr
		}
		for _, document := range rows {
			documents[document.ID] = document
		}
	}
	documentRefs := make([]gin.H, 0, len(refs))
	for _, ref := range refs {
		var chunkIndexes []int
		if ref.ChunkIndexesJSON != nil {
			_ = json.Unmarshal([]byte(*ref.ChunkIndexesJSON), &chunkIndexes)
		}
		item := gin.H{
			"id": fmt.Sprintf("%d", ref.ID), "documentId": fmt.Sprintf("%d", ref.DocumentID),
			"documentTitle": "", "fileName": "", "chunkIndexes": chunkIndexes, "note": ref.Note,
		}
		if document := documents[ref.DocumentID]; document != nil {
			item["documentTitle"], item["fileName"] = document.Title, document.FileName
		}
		documentRefs = append(documentRefs, item)
	}
	linkRows, err := s.client.KBWikiLink.Query().Where(
		kbwikilink.FromPageIDEQ(row.ID),
	).Order(ent.Asc(kbwikilink.FieldToPageKey)).All(ctx)
	if err != nil {
		return nil, err
	}
	links := make([]gin.H, 0, len(linkRows))
	for _, link := range linkRows {
		links = append(links, gin.H{
			"id": fmt.Sprintf("%d", link.ID), "toPageKey": link.ToPageKey, "linkType": link.LinkType,
		})
	}
	out := toWikiPageDTO(row)
	out["documentRefs"], out["links"] = documentRefs, links
	return out, nil
}

// LoadWikiPageMediaForAgent 返回 Wiki 正文中可直接展示的媒体引用。
// 文件来源通过 documentRefs 和文件浏览接口读取，不再回查旧文章来源。
func (s *Service) LoadWikiPageMediaForAgent(_ context.Context, _, _ int64, detail gin.H) ([]AgentMediaReference, error) {
	contentMD, _ := detail["contentMd"].(string)
	return ExtractAgentMediaReferences(contentMD, nil, nil), nil
}

// AgentWikiPageHit 是供 Assistant 与外部 Agent 使用的轻量 Wiki 检索结果。
type AgentWikiPageHit struct {
	Type              string `json:"type"`
	KnowledgeBaseID   string `json:"knowledgeBaseId"`
	KnowledgeBaseName string `json:"knowledgeBaseName,omitempty"`
	PageKey           string `json:"pageKey"`
	ArticleID         any    `json:"articleId"`
	Title             string `json:"title"`
	Summary           string `json:"summary,omitempty"`
	UpdatedAt         string `json:"updatedAt,omitempty"`
}

// SearchAgentWikiPages 在文件 Wiki 标题、摘要和正文中检索。
func (s *Service) SearchAgentWikiPages(ctx context.Context, userID int64, kbID *int64, query string, limit int) ([]AgentWikiPageHit, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []AgentWikiPageHit{}, nil
	}
	limit = maxInt(1, minInt(limit, 20))
	if kbID != nil {
		if err := s.assertKBOwner(ctx, userID, *kbID); err != nil {
			return nil, err
		}
	}
	q := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.ArchivedAtIsNil(),
		kbwikipage.Or(kbwikipage.TitleContainsFold(query), kbwikipage.ContentMdContainsFold(query), kbwikipage.SummaryContainsFold(query)),
	)
	if kbID != nil {
		q = q.Where(kbwikipage.KnowledgeBaseIDEQ(*kbID))
	}
	rows, err := q.Order(ent.Desc(kbwikipage.FieldUpdatedAt)).Limit(limit).All(ctx)
	if err != nil {
		return nil, err
	}
	kbIDs := make([]int64, 0, len(rows))
	seenKB := make(map[int64]struct{}, len(rows))
	for _, row := range rows {
		if _, exists := seenKB[row.KnowledgeBaseID]; !exists {
			seenKB[row.KnowledgeBaseID] = struct{}{}
			kbIDs = append(kbIDs, row.KnowledgeBaseID)
		}
	}
	kbNames := make(map[int64]string, len(kbIDs))
	if len(kbIDs) > 0 {
		bases, loadErr := s.client.KnowledgeBase.Query().Where(knowledgebase.UserIDEQ(userID), knowledgebase.IDIn(kbIDs...)).All(ctx)
		if loadErr != nil {
			return nil, loadErr
		}
		for _, base := range bases {
			kbNames[base.ID] = base.Name
		}
	}
	out := make([]AgentWikiPageHit, 0, len(rows))
	for _, row := range rows {
		out = append(out, AgentWikiPageHit{
			Type: "wiki", KnowledgeBaseID: fmt.Sprintf("%d", row.KnowledgeBaseID), KnowledgeBaseName: kbNames[row.KnowledgeBaseID],
			PageKey: row.PageKey, ArticleID: nil, Title: row.Title, Summary: wikiPageSummary(row, 220),
			UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	return out, nil
}

// RunWikiLintForAgent 检查当前文件 Wiki，不再依赖补丁或文章章节树。
func (s *Service) RunWikiLintForAgent(ctx context.Context, userID, kbID int64) (gin.H, error) {
	if err := s.assertKBOwner(ctx, userID, kbID); err != nil {
		return nil, err
	}
	pages, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
	).Order(ent.Asc(kbwikipage.FieldKind), ent.Asc(kbwikipage.FieldTitle)).All(ctx)
	if err != nil {
		return nil, err
	}
	links, err := s.client.KBWikiLink.Query().Where(
		kbwikilink.UserIDEQ(userID), kbwikilink.KnowledgeBaseIDEQ(kbID),
	).All(ctx)
	if err != nil {
		return nil, err
	}
	pageIDs := make([]int64, 0, len(pages))
	pageKeys := make(map[string]struct{}, len(pages))
	for _, page := range pages {
		pageIDs = append(pageIDs, page.ID)
		pageKeys[page.PageKey] = struct{}{}
	}
	refs := []*ent.KBWikiDocumentRef{}
	if len(pageIDs) > 0 {
		refs, err = s.client.KBWikiDocumentRef.Query().Where(kbwikidocumentref.PageIDIn(pageIDs...)).All(ctx)
		if err != nil {
			return nil, err
		}
	}
	refsByPage := make(map[int64]struct{}, len(refs))
	for _, ref := range refs {
		refsByPage[ref.PageID] = struct{}{}
	}
	linkedTo := make(map[string]int)
	issues := make([]gin.H, 0)
	for _, link := range links {
		linkedTo[link.ToPageKey]++
		if _, exists := pageKeys[link.ToPageKey]; !exists {
			issues = append(issues, gin.H{
				"severity": "error", "code": "broken_link", "pageKey": link.ToPageKey,
				"title": link.ToPageKey, "message": "链接指向不存在的 Wiki 页面",
			})
		}
	}
	for _, page := range pages {
		if page.Kind != "index" {
			if _, exists := refsByPage[page.ID]; !exists {
				issues = append(issues, gin.H{
					"severity": "warning", "code": "missing_document_source", "pageKey": page.PageKey,
					"title": page.Title, "message": "页面缺少文件分片来源",
				})
			}
			if linkedTo[page.PageKey] == 0 {
				issues = append(issues, gin.H{
					"severity": "info", "code": "orphan_page", "pageKey": page.PageKey,
					"title": page.Title, "message": "页面暂时没有被其他页面引用",
				})
			}
		}
	}
	errorCount, warningCount := 0, 0
	for _, issue := range issues {
		switch issue["severity"] {
		case "error":
			errorCount++
		case "warning":
			warningCount++
		}
	}
	score := maxInt(0, 100-errorCount*25-warningCount*8)
	return gin.H{
		"score": score, "pageCount": len(pages), "linkCount": len(links),
		"documentRefCount": len(refs), "issueCount": len(issues), "issues": issues,
		"checkedAt": time.Now().UTC().Format(time.RFC3339Nano),
	}, nil
}

func toWikiPageDTO(row *ent.KBWikiPage) gin.H {
	if row == nil {
		return nil
	}
	var frontmatter any
	if row.FrontmatterJSON != nil && strings.TrimSpace(*row.FrontmatterJSON) != "" {
		_ = json.Unmarshal([]byte(*row.FrontmatterJSON), &frontmatter)
	}
	if frontmatter == nil {
		frontmatter = map[string]any{}
	}
	categoryPath := decodeWikiCategoryPath(row.CategoryPathJSON)
	if categoryPath == nil {
		categoryPath = []string{}
	}
	return gin.H{
		"id": fmt.Sprintf("%d", row.ID), "knowledgeBaseId": fmt.Sprintf("%d", row.KnowledgeBaseID),
		"pageKey": row.PageKey, "title": row.Title, "kind": row.Kind, "contentMd": row.ContentMd,
		"frontmatter": frontmatter, "summary": row.Summary, "contentHash": row.ContentHash,
		"categoryPath": categoryPath, "sortOrder": row.SortOrder,
		"version": row.Version, "archivedAt": formatTimePtr(row.ArchivedAt),
		"createdAt": formatTimePtr(&row.CreatedAt), "updatedAt": formatTimePtr(&row.UpdatedAt),
	}
}

var (
	wikiPageKeySeparators = regexp.MustCompile(`[\s\\#?&=]+`)
	wikiPageKeyInvalid    = regexp.MustCompile(`[^a-z0-9一-龥._/-]+`)
	wikiPageKeyDashes     = regexp.MustCompile(`-+`)
	wikiPageKeySlashes    = regexp.MustCompile(`/+`)
	legacyArticleWikiKey  = regexp.MustCompile(`^source-[0-9]+$`)
)

func normalizeWikiPageKey(input string) string {
	key := strings.ToLower(strings.TrimSpace(input))
	key = wikiPageKeySeparators.ReplaceAllString(key, "-")
	key = wikiPageKeyInvalid.ReplaceAllString(key, "")
	key = wikiPageKeyDashes.ReplaceAllString(key, "-")
	key = wikiPageKeySlashes.ReplaceAllString(key, "/")
	key = strings.Trim(key, "-/")
	if key != "" {
		return key
	}
	sum := sha256.Sum256([]byte(input))
	return "page-" + hex.EncodeToString(sum[:])[:12]
}

func hashText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

func uniqueTrimWarnings(items []string, limit int) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, minInt(len(items), limit))
	for _, item := range items {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if _, exists := seen[item]; exists {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
		if len(out) == limit {
			break
		}
	}
	return out
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func estimateChunkTokens(text string) int {
	tokens := 0.0
	for _, char := range text {
		switch {
		case char >= 0x4e00 && char <= 0x9fff, char >= 0x3040 && char <= 0x30ff, char >= 0xac00 && char <= 0xd7af:
			tokens++
		default:
			tokens += 0.25
		}
	}
	return int(tokens + 0.999999)
}

func extractWikiHeadings(markdown string) []string {
	items := make([]string, 0)
	inFence := false
	for _, line := range strings.Split(markdown, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if match := articleHeadingLineRE.FindStringSubmatch(trimmed); len(match) == 3 {
			title := strings.TrimSpace(strings.TrimRight(match[2], "#"))
			if title != "" {
				items = append(items, title)
			}
		}
	}
	return items
}

func wikiPageSummary(page *ent.KBWikiPage, limit int) string {
	if page.Summary != nil && strings.TrimSpace(*page.Summary) != "" {
		return truncateRunes(strings.Join(strings.Fields(*page.Summary), " "), limit)
	}
	return truncateRunes(markdownToPlainText(page.ContentMd), limit)
}

func tokenizeSearchQuery(query string) []string {
	normalized := strings.ToLower(strings.TrimSpace(query))
	if normalized == "" {
		return nil
	}
	parts := regexp.MustCompile(`[\s\p{P}\p{S}]+`).Split(normalized, -1)
	terms := make(map[string]struct{})
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		terms[part] = struct{}{}
		runes := []rune(part)
		if len(runes) >= 3 {
			for _, size := range []int{2, 3} {
				if len(runes) < size {
					continue
				}
				for index := 0; index <= len(runes)-size; index++ {
					terms[string(runes[index:index+size])] = struct{}{}
				}
			}
		}
	}
	out := make([]string, 0, len(terms))
	for term := range terms {
		out = append(out, term)
	}
	return out
}
