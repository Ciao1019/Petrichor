package kb

/*
import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunk"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikidocumentref"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikilink"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type documentWikiTopic struct {
	Slug      string   `json:"slug"`
	Title     string   `json:"title"`
	Summary   string   `json:"summary"`
	ContentMD string   `json:"contentMd"`
	Links     []string `json:"links"`
}

type documentWikiDraft struct {
	Summary string              `json:"summary"`
	Topics  []documentWikiTopic `json:"topics"`
}

// Wiki 构建由 Next 同源代理发起，代理连接通常只有约 30 秒可用。
// 模型抽取只占用其中一部分预算，超时后立即使用确定性的标题规则继续构建，
// 给数据库写入和响应返回留出时间，避免请求取消后拿失效 context 继续写库。
const documentWikiModelBudget = 20 * time.Second

// WikiDocumentIngest 从解析后的知识库文件生成 Wiki 页面和双链。
func (h *Handler) WikiDocumentIngest(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string   `json:"knowledgeBaseId" binding:"required"`
		DocumentIDs     []string `json:"documentIds"`
		ForceRebuild    bool     `json:"forceRebuild"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	result, err := h.svc.IngestKnowledgeBaseDocumentsWiki(c.Request.Context(), u.ID, kbID, req.DocumentIDs, req.ForceRebuild)
	if err != nil {
		response.Fail(c, fmt.Errorf("wiki document ingest failed (user_id=%d knowledge_base_id=%d force_rebuild=%t): %w", u.ID, kbID, req.ForceRebuild, err))
		return
	}
	response.OK(c, result)
}

// WikiGraph 返回 Wiki 页面双链图。它只表达页面引用，不是实体关系知识图谱。
func (h *Handler) WikiGraph(c *gin.Context) {
	var req idRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	pages, err := h.svc.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(u.ID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
	).Order(ent.Asc(kbwikipage.FieldTitle)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	links, err := h.svc.client.KBWikiLink.Query().Where(
		kbwikilink.UserIDEQ(u.ID), kbwikilink.KnowledgeBaseIDEQ(kbID),
	).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	pageByID, keys := make(map[int64]*ent.KBWikiPage, len(pages)), make(map[string]struct{}, len(pages))
	degree := make(map[string]int)
	for _, page := range pages {
		pageByID[page.ID], keys[page.PageKey] = page, struct{}{}
	}
	edges := make([]gin.H, 0, len(links))
	seen := map[string]struct{}{}
	for _, link := range links {
		from := pageByID[link.FromPageID]
		if from == nil {
			continue
		}
		if _, ok := keys[link.ToPageKey]; !ok || from.PageKey == link.ToPageKey {
			continue
		}
		edgeKey := from.PageKey + "\x00" + link.ToPageKey
		if _, ok := seen[edgeKey]; ok {
			continue
		}
		seen[edgeKey] = struct{}{}
		degree[from.PageKey]++
		degree[link.ToPageKey]++
		edges = append(edges, gin.H{"source": from.PageKey, "target": link.ToPageKey, "linkType": link.LinkType})
	}
	nodes := make([]gin.H, 0, len(pages))
	for _, page := range pages {
		nodes = append(nodes, gin.H{
			"pageKey": page.PageKey, "title": page.Title, "kind": page.Kind,
			"summary": page.Summary, "linkCount": degree[page.PageKey],
		})
	}
	response.OK(c, gin.H{"nodes": nodes, "edges": edges})
}

func (s *Service) IngestKnowledgeBaseDocumentsWiki(
	ctx context.Context,
	userID, kbID int64,
	documentIDStrings []string,
	forceRebuild bool,
) (gin.H, error) {
	kbRow, err := s.GetOwned(ctx, userID, kbID)
	if err != nil {
		return nil, err
	}
	query := s.client.KBDocument.Query().Where(kbdocument.UserIDEQ(userID), kbdocument.KnowledgeBaseIDEQ(kbID))
	if len(documentIDStrings) > 0 {
		ids := make([]int64, 0, len(documentIDStrings))
		for _, raw := range documentIDStrings {
			id, err := parsePositiveID(raw, "documentId")
			if err != nil {
				return nil, err
			}
			ids = append(ids, id)
		}
		query = query.Where(kbdocument.IDIn(ids...))
	}
	documents, err := query.Order(ent.Asc(kbdocument.FieldID)).All(ctx)
	if err != nil {
		return nil, err
	}
	if len(documents) == 0 {
		return nil, response.BadRequest("知识库里还没有可构建 Wiki 的文件")
	}
	if len(documentIDStrings) > 0 && len(documents) != len(documentIDStrings) {
		return nil, response.BadRequest("部分文件不存在或不属于该知识库")
	}
	pageMap := make(map[string]*ent.KBWikiPage)
	generatedKeys := make(map[string]struct{})
	warnings := make([]string, 0)
	modelCtx, cancelModel := context.WithTimeout(ctx, documentWikiModelBudget)
	defer cancelModel()
	if len(documentIDStrings) == 0 && forceRebuild {
		// 全量重建先归档不属于文件 Wiki 的历史页面，并清除所有旧文件引用，
		// 防止旧“文章编译 Wiki”页面或过期主题继续出现在索引与双链图中。
		legacyPages, loadErr := s.client.KBWikiPage.Query().Where(
			kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID),
			kbwikipage.Or(
				kbwikipage.KindNotIn("index", "source", "concept"),
				kbwikipage.PageKeyHasPrefix("source-"),
			),
		).All(ctx)
		if loadErr != nil {
			return nil, loadErr
		}
		for _, page := range legacyPages {
			if page.Kind == "index" || page.Kind == "source" || page.Kind == "concept" {
				if !legacyArticleWikiKey.MatchString(page.PageKey) {
					continue
				}
			}
			if archiveErr := s.archiveWikiPage(ctx, userID, kbID, page); archiveErr != nil {
				return nil, archiveErr
			}
		}
		activePages, loadErr := s.client.KBWikiPage.Query().Where(
			kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
		).IDs(ctx)
		if loadErr != nil {
			return nil, loadErr
		}
		if len(activePages) > 0 {
			if _, deleteErr := s.client.KBWikiDocumentRef.Delete().Where(kbwikidocumentref.PageIDIn(activePages...)).Exec(ctx); deleteErr != nil {
				return nil, deleteErr
			}
		}
	}
	for _, document := range documents {
		if _, err := s.client.KBWikiDocumentRef.Delete().Where(
			kbwikidocumentref.DocumentIDEQ(document.ID),
		).Exec(ctx); err != nil {
			return nil, err
		}
		chunks, err := s.client.KBDocumentChunk.Query().Where(
			kbdocumentchunk.DocumentIDEQ(document.ID), kbdocumentchunk.UserIDEQ(userID),
		).Order(ent.Asc(kbdocumentchunk.FieldChunkIndex)).All(ctx)
		if err != nil {
			return nil, err
		}
		if len(chunks) == 0 {
			warnings = append(warnings, document.Title+" 没有可用分片，已跳过")
			continue
		}
		content, chunkIndexes := documentWikiContent(chunks, 16000)
		draft, warning := s.generateDocumentWikiDraft(modelCtx, userID, kbID, document.Title, content)
		if warning != "" {
			warnings = append(warnings, document.Title+"："+warning)
		}
		sourcePage, err := s.upsertDocumentSourceWikiPage(ctx, userID, kbID, document, draft, chunkIndexes, forceRebuild)
		if err != nil {
			return nil, err
		}
		pageMap[sourcePage.PageKey] = sourcePage
		generatedKeys[sourcePage.PageKey] = struct{}{}

		topicKeys := make([]string, 0, len(draft.Topics))
		for _, topic := range draft.Topics {
			page, err := s.upsertDocumentTopicWikiPage(ctx, userID, kbID, document.ID, topic, chunkIndexes, forceRebuild)
			if err != nil {
				return nil, err
			}
			pageMap[page.PageKey] = page
			generatedKeys[page.PageKey] = struct{}{}
			topicKeys = append(topicKeys, page.PageKey)
		}
		if err := s.replacePageWikiLinks(ctx, userID, kbID, sourcePage.ID, topicKeys, "mentions"); err != nil {
			return nil, err
		}
	}
	// 无论局部还是全量重建，都归档已经失去全部文件来源的旧页面。
	stalePages, loadErr := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID),
		kbwikipage.ArchivedAtIsNil(), kbwikipage.KindIn("source", "concept"),
	).All(ctx)
	if loadErr != nil {
		return nil, loadErr
	}
	for _, page := range stalePages {
		if _, current := generatedKeys[page.PageKey]; current {
			continue
		}
		refCount, countErr := s.client.KBWikiDocumentRef.Query().Where(kbwikidocumentref.PageIDEQ(page.ID)).Count(ctx)
		if countErr != nil {
			return nil, countErr
		}
		if refCount == 0 {
			if archiveErr := s.archiveWikiPage(ctx, userID, kbID, page); archiveErr != nil {
				return nil, archiveErr
			}
		}
	}
	indexPage, err := s.rebuildWikiIndex(ctx, userID, kbID, kbRow.Name)
	if err != nil {
		return nil, err
	}
	pageMap[indexPage.PageKey] = indexPage
	items := make([]gin.H, 0, len(pageMap))
	for _, page := range pageMap {
		items = append(items, toWikiPageDTO(page))
	}
	sort.Slice(items, func(i, j int) bool {
		return fmt.Sprint(items[i]["title"]) < fmt.Sprint(items[j]["title"])
	})
	return gin.H{
		"knowledgeBaseId": fmt.Sprintf("%d", kbID), "pages": items,
		"indexPage": toWikiPageDTO(indexPage), "warnings": uniqueTrimWarnings(warnings, 8),
	}, nil
}

// CleanupWikiAfterDocumentDelete 归档失去全部文件来源的页面，并重建索引。
func (s *Service) CleanupWikiAfterDocumentDelete(ctx context.Context, userID, kbID int64) (gin.H, error) {
	kbRow, err := s.GetOwned(ctx, userID, kbID)
	if err != nil {
		return nil, err
	}
	pages, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID),
		kbwikipage.ArchivedAtIsNil(), kbwikipage.KindIn("source", "concept"),
	).All(ctx)
	if err != nil {
		return nil, err
	}
	archived := 0
	for _, page := range pages {
		count, countErr := s.client.KBWikiDocumentRef.Query().Where(kbwikidocumentref.PageIDEQ(page.ID)).Count(ctx)
		if countErr != nil {
			return nil, countErr
		}
		if count > 0 {
			continue
		}
		if archiveErr := s.archiveWikiPage(ctx, userID, kbID, page); archiveErr != nil {
			return nil, archiveErr
		}
		archived++
	}
	_, err = s.rebuildWikiIndex(ctx, userID, kbID, kbRow.Name)
	if err != nil {
		return nil, err
	}
	return gin.H{"archivedPages": archived, "rebuilt": true}, nil
}

func (s *Service) archiveWikiPage(ctx context.Context, userID, kbID int64, page *ent.KBWikiPage) error {
	if _, err := page.Update().SetArchivedAt(time.Now().UTC()).Save(ctx); err != nil {
		return err
	}
	if _, err := s.client.KBWikiLink.Delete().Where(
		kbwikilink.Or(
			kbwikilink.FromPageIDEQ(page.ID),
			kbwikilink.And(
				kbwikilink.UserIDEQ(userID), kbwikilink.KnowledgeBaseIDEQ(kbID), kbwikilink.ToPageKeyEQ(page.PageKey),
			),
		),
	).Exec(ctx); err != nil {
		return err
	}
	return nil
}

func documentWikiContent(chunks []*ent.KBDocumentChunk, limit int) (string, []int) {
	parts := make([]string, 0, len(chunks))
	indexes := make([]int, 0, len(chunks))
	length := 0
	for _, chunk := range chunks {
		text := strings.TrimSpace(chunk.Text)
		if text == "" {
			continue
		}
		if length+len([]rune(text)) > limit {
			remaining := limit - length
			if remaining > 0 {
				parts = append(parts, fmt.Sprintf("[chunk:%d]\n%s", chunk.ChunkIndex, string([]rune(text)[:remaining])))
				indexes = append(indexes, chunk.ChunkIndex)
			}
			break
		}
		parts = append(parts, fmt.Sprintf("[chunk:%d]\n%s", chunk.ChunkIndex, text))
		indexes = append(indexes, chunk.ChunkIndex)
		length += len([]rune(text))
	}
	return strings.Join(parts, "\n\n"), indexes
}

func (s *Service) generateDocumentWikiDraft(ctx context.Context, userID, kbID int64, title, content string) (documentWikiDraft, string) {
	fallback := fallbackDocumentWikiDraft(title, content)
	if err := ctx.Err(); err != nil {
		s.log.Warn("wiki document model generation skipped",
			zap.Int64("user_id", userID),
			zap.Int64("knowledge_base_id", kbID),
			zap.String("document_title", title),
			zap.Error(err),
		)
		return fallback, "模型生成预算已用完，已按标题结构生成"
	}
	kbRow, err := s.GetOwned(ctx, userID, kbID)
	if err != nil {
		s.log.Warn("wiki document model configuration unavailable",
			zap.Int64("user_id", userID),
			zap.Int64("knowledge_base_id", kbID),
			zap.String("document_title", title),
			zap.Error(err),
		)
		return fallback, "无法读取知识库模型设置，已按标题结构生成"
	}
	modelCfg, err := ai.ResolveChatConfigByID(ctx, s.client, userID, kbRow.ChatModelID)
	if err != nil {
		s.log.Warn("wiki document chat model unavailable",
			zap.Int64("user_id", userID),
			zap.Int64("knowledge_base_id", kbID),
			zap.String("document_title", title),
			zap.Error(err),
		)
		return fallback, "未找到可用对话模型，已按标题结构生成"
	}
	result, err := ai.NewGeneration(s.cfg).Chat(ctx, modelCfg, []ai.ChatMessage{
		{Role: "system", Content: strings.Join([]string{
			"你是 Wiki 编译器。把一份原始文档拆成少量可复用、可互相引用的 Wiki 主题页。",
			"这不是实体关系知识图谱，不要输出节点/边或三元组。",
			"只输出 JSON：{\"summary\":\"文档摘要\",\"topics\":[{\"slug\":\"稳定短标识\",\"title\":\"标题\",\"summary\":\"摘要\",\"contentMd\":\"Markdown 正文\",\"links\":[\"其他 topic slug\"]}]}。",
			"topics 最多 6 个；正文应归纳事实并保留 [chunk:N] 引用；links 只能引用本次 topics 的 slug。",
		}, "\n")},
		{Role: "user", Content: "文档标题：" + title + "\n\n解析内容：\n" + content},
	})
	if err != nil {
		s.log.Warn("wiki document model generation failed, using fallback",
			zap.Int64("user_id", userID),
			zap.Int64("knowledge_base_id", kbID),
			zap.Int64("model_id", modelCfg.ID),
			zap.String("document_title", title),
			zap.Error(err),
		)
		if ctx.Err() != nil {
			return fallback, "模型提取超时，已按标题结构生成"
		}
		return fallback, "模型提取失败，已按标题结构生成"
	}
	text := result.Content
	if start, end := strings.Index(text, "{"), strings.LastIndex(text, "}"); start >= 0 && end > start {
		text = text[start : end+1]
	}
	var draft documentWikiDraft
	if err := json.Unmarshal([]byte(text), &draft); err != nil {
		s.log.Warn("wiki document model output is invalid",
			zap.Int64("user_id", userID),
			zap.Int64("knowledge_base_id", kbID),
			zap.Int64("model_id", modelCfg.ID),
			zap.String("document_title", title),
			zap.Error(err),
		)
		return fallback, "模型输出无法解析，已按标题结构生成"
	}
	draft.Summary = truncateRunes(strings.TrimSpace(draft.Summary), 600)
	if draft.Summary == "" {
		draft.Summary = fallback.Summary
	}
	clean := make([]documentWikiTopic, 0, minInt(len(draft.Topics), 6))
	seen := map[string]struct{}{}
	for _, topic := range draft.Topics {
		topic.Slug = normalizeWikiPageKey(topic.Slug)
		topic.Title = strings.TrimSpace(topic.Title)
		if topic.Slug == "" {
			topic.Slug = normalizeWikiPageKey(topic.Title)
		}
		if topic.Slug == "" || topic.Title == "" {
			continue
		}
		if _, ok := seen[topic.Slug]; ok {
			continue
		}
		seen[topic.Slug] = struct{}{}
		topic.Summary = truncateRunes(strings.TrimSpace(topic.Summary), 500)
		topic.ContentMD = strings.TrimSpace(topic.ContentMD)
		if topic.ContentMD == "" {
			topic.ContentMD = "# " + topic.Title + "\n\n" + topic.Summary
		}
		clean = append(clean, topic)
		if len(clean) == 6 {
			break
		}
	}
	if len(clean) == 0 {
		return fallback, "未提取到主题，已按标题结构生成"
	}
	draft.Topics = clean
	return draft, ""
}

func fallbackDocumentWikiDraft(title, content string) documentWikiDraft {
	plain := strings.TrimSpace(markdownToPlainText(content))
	summary := truncateRunes(plain, 500)
	headings := extractWikiHeadings(content)
	if len(headings) == 0 {
		headings = []string{title}
	}
	seen := map[string]struct{}{}
	topics := make([]documentWikiTopic, 0, minInt(len(headings), 6))
	for _, heading := range headings {
		slug := normalizeWikiPageKey(heading)
		if slug == "" {
			continue
		}
		if _, ok := seen[slug]; ok {
			continue
		}
		seen[slug] = struct{}{}
		topics = append(topics, documentWikiTopic{
			Slug: slug, Title: heading, Summary: summary,
			ContentMD: "# " + heading + "\n\n" + summary,
		})
		if len(topics) == 6 {
			break
		}
	}
	return documentWikiDraft{Summary: summary, Topics: topics}
}

func (s *Service) upsertDocumentSourceWikiPage(
	ctx context.Context, userID, kbID int64, document *ent.KBDocument, draft documentWikiDraft, chunkIndexes []int, force bool,
) (*ent.KBWikiPage, error) {
	key := fmt.Sprintf("document-%d", document.ID)
	links := make([]string, 0, len(draft.Topics))
	for _, topic := range draft.Topics {
		links = append(links, fmt.Sprintf("- [[%s]] %s", topic.Slug, topic.Title))
	}
	content := strings.Join([]string{
		"# " + document.Title, "", "## 摘要", draft.Summary, "", "## 主题页面", strings.Join(links, "\n"),
		"", "## 来源", fmt.Sprintf("- 文件：%s", document.FileName), fmt.Sprintf("- 文件 ID：%d", document.ID),
	}, "\n")
	page, err := s.upsertWikiPage(ctx, userID, kbID, key, document.Title, "source", draft.Summary, content, force)
	if err != nil {
		return nil, err
	}
	if err := s.upsertWikiDocumentRef(ctx, page.ID, document.ID, chunkIndexes); err != nil {
		return nil, err
	}
	return page, nil
}

func (s *Service) upsertDocumentTopicWikiPage(
	ctx context.Context, userID, kbID, documentID int64, topic documentWikiTopic, chunkIndexes []int, force bool,
) (*ent.KBWikiPage, error) {
	content := topic.ContentMD
	if !strings.HasPrefix(strings.TrimSpace(content), "#") {
		content = "# " + topic.Title + "\n\n" + content
	}
	if len(topic.Links) > 0 {
		linkLines := make([]string, 0, len(topic.Links))
		for _, key := range topic.Links {
			key = normalizeWikiPageKey(key)
			if key != "" && key != topic.Slug {
				linkLines = append(linkLines, "- [["+key+"]]")
			}
		}
		if len(linkLines) > 0 {
			content += "\n\n## 相关页面\n" + strings.Join(linkLines, "\n")
		}
	}
	page, err := s.upsertWikiPage(ctx, userID, kbID, topic.Slug, topic.Title, "concept", topic.Summary, content, force)
	if err != nil {
		return nil, err
	}
	if err := s.upsertWikiDocumentRef(ctx, page.ID, documentID, chunkIndexes); err != nil {
		return nil, err
	}
	if err := s.replacePageWikiLinks(ctx, userID, kbID, page.ID, topic.Links, "related"); err != nil {
		return nil, err
	}
	return page, nil
}

func (s *Service) upsertWikiPage(ctx context.Context, userID, kbID int64, key, title, kind, summary, content string, force bool) (*ent.KBWikiPage, error) {
	key = normalizeWikiPageKey(key)
	hash := hashText(content)
	existing, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.PageKeyEQ(key),
	).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return nil, err
	}
	if existing != nil {
		if !force && existing.ContentHash == hash {
			return existing, nil
		}
		return existing.Update().SetTitle(title).SetKind(kind).SetSummary(summary).SetContentMd(content).
			SetContentHash(hash).SetVersion(existing.Version + 1).ClearArchivedAt().Save(ctx)
	}
	return s.client.KBWikiPage.Create().SetUserID(userID).SetKnowledgeBaseID(kbID).SetPageKey(key).
		SetTitle(title).SetKind(kind).SetSummary(summary).SetContentMd(content).SetContentHash(hash).SetVersion(1).Save(ctx)
}

func (s *Service) upsertWikiDocumentRef(ctx context.Context, pageID, documentID int64, chunkIndexes []int) error {
	raw, _ := json.Marshal(chunkIndexes)
	existing, err := s.client.KBWikiDocumentRef.Query().Where(
		kbwikidocumentref.PageIDEQ(pageID), kbwikidocumentref.DocumentIDEQ(documentID),
	).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		return err
	}
	if existing != nil {
		_, err = existing.Update().SetChunkIndexesJSON(string(raw)).SetNote("源文件分片").Save(ctx)
		return err
	}
	return s.client.KBWikiDocumentRef.Create().SetPageID(pageID).SetDocumentID(documentID).
		SetChunkIndexesJSON(string(raw)).SetNote("源文件分片").Exec(ctx)
}

func (s *Service) replacePageWikiLinks(ctx context.Context, userID, kbID, fromPageID int64, rawKeys []string, linkType string) error {
	if _, err := s.client.KBWikiLink.Delete().Where(kbwikilink.FromPageIDEQ(fromPageID)).Exec(ctx); err != nil {
		return err
	}
	seen := map[string]struct{}{}
	builders := make([]*ent.KBWikiLinkCreate, 0, len(rawKeys))
	for _, raw := range rawKeys {
		key := normalizeWikiPageKey(raw)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		builders = append(builders, s.client.KBWikiLink.Create().SetUserID(userID).SetKnowledgeBaseID(kbID).
			SetFromPageID(fromPageID).SetToPageKey(key).SetLinkType(linkType))
	}
	if len(builders) == 0 {
		return nil
	}
	_, err := s.client.KBWikiLink.CreateBulk(builders...).Save(ctx)
	return err
}

func (s *Service) rebuildWikiIndex(ctx context.Context, userID, kbID int64, kbName string) (*ent.KBWikiPage, error) {
	pages, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
	).Order(ent.Asc(kbwikipage.FieldKind), ent.Asc(kbwikipage.FieldTitle)).All(ctx)
	if err != nil {
		return nil, err
	}
	sourcePages, conceptPages := make([]*ent.KBWikiPage, 0), make([]*ent.KBWikiPage, 0)
	for _, page := range pages {
		if page.PageKey == "index" || page.Kind == "index" {
			continue
		}
		if page.Kind == "source" {
			sourcePages = append(sourcePages, page)
		} else {
			conceptPages = append(conceptPages, page)
		}
	}
	lines := []string{
		"# " + kbName + " Wiki 索引", "",
		"这个页面汇总由知识库文件生成的 Wiki。回答问题时先检索文件分片和 Wiki 页面，并保留来源定位。",
		"", "## 文件页面",
	}
	for _, page := range sourcePages {
		lines = append(lines, fmt.Sprintf("- [[%s]] %s：%s", page.PageKey, page.Title, wikiPageSummary(page, 120)))
	}
	lines = append(lines, "", "## 主题页面")
	if len(conceptPages) == 0 {
		lines = append(lines, "- 暂无主题页面")
	} else {
		for _, page := range conceptPages {
			lines = append(lines, fmt.Sprintf("- [[%s]] %s：%s", page.PageKey, page.Title, wikiPageSummary(page, 120)))
		}
	}
	lines = append(lines, "", "## 维护规则", "- 知识库文件和分片是真源。", "- Wiki 只做归纳、导航与双链，不代替原文件。", "- 回答时应定位到具体文件与分片。")
	content := strings.Join(lines, "\n")
	summary := fmt.Sprintf("收录 %d 个文件页面，%d 个主题页面。", len(sourcePages), len(conceptPages))
	frontmatter, _ := json.Marshal(map[string]int{"sourcePageCount": len(sourcePages), "conceptPageCount": len(conceptPages)})
	indexPage, err := s.upsertWikiPage(ctx, userID, kbID, "index", kbName+" 索引", "index", summary, content, true)
	if err != nil {
		return nil, err
	}
	if _, err := indexPage.Update().SetFrontmatterJSON(string(frontmatter)).Save(ctx); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(sourcePages)+len(conceptPages))
	for _, page := range append(sourcePages, conceptPages...) {
		keys = append(keys, page.PageKey)
	}
	if err := s.replacePageWikiLinks(ctx, userID, kbID, indexPage.ID, keys, "index"); err != nil {
		return nil, err
	}
	return indexPage, nil
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}
*/
