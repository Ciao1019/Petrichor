// wiki-export.go POST /api/kb/wiki/export：把一个知识库的 Wiki 打包成
// Google Open Knowledge Format（OKF）bundle 并以 zip 附件返回。
//
// 产物结构（OKF 只保留 index.md / log.md 两个根文件名，其余目录自由）：
//
//	index.md          bundle 清单，声明 okf_version
//	log.md            Wiki 变更时间线
//	sources/*.md      源文档页面
//	concepts/*.md     概念页面
//	entities/*.md     实体页面
//	guides/*.md       编译说明书等 meta 页面
//
// format=okf 时 [[wikilink]] 改写成 bundle 绝对路径的标准 Markdown 链接；
// format=obsidian 时原样保留，可直接当 Obsidian vault 打开。
package kb

import (
	"archive/zip"
	"bytes"
	"context"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// wikiExportEventLimit log.md 最多回溯的事件条数，避免大知识库导出体积失控。
const wikiExportEventLimit = 500

type okfBundleFile struct {
	name    string
	content []byte
}

// WikiExport 导出知识库 Wiki 为 OKF bundle。
func WikiExport(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		format, err := parseOKFFormat(raw["format"])
		if err != nil {
			return nil, err
		}
		q := pool()
		ctx := c.Request.Context()
		kbRow, err := assertKnowledgeBaseOwner(ctx, q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		files, err := buildOKFBundle(ctx, q, user.ID, kbRow, format)
		if err != nil {
			return nil, err
		}
		archive, err := zipBundle(files)
		if err != nil {
			return nil, err
		}
		filename := "petrichor-kb-" + strconv.FormatInt(kbID, 10) + "-" + format + ".zip"
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
		c.Data(http.StatusOK, "application/zip", archive)
		// 响应已直接写出，返回 nil 让 run 跳过 JSON 包装。
		return nil, nil
	})
}

func parseOKFFormat(value any) (string, error) {
	format := strings.ToLower(strings.TrimSpace(toStr(value)))
	switch format {
	case "":
		return OKFFormatOKF, nil
	case OKFFormatOKF, OKFFormatObsidian:
		return format, nil
	default:
		return "", badReq("format 只支持 okf 或 obsidian")
	}
}

// buildOKFBundle 组装 bundle 内的全部文件，按路径稳定排序。
func buildOKFBundle(ctx context.Context, q execQuerier, userID int64, kbRow *KBRow, format string) ([]okfBundleFile, error) {
	pages, err := loadWikiPageRows(ctx, q, userID, kbRow.ID)
	if err != nil {
		return nil, err
	}
	if len(pages) == 0 {
		return nil, badReq("这个知识库还没有编译出 Wiki 页面，先执行一次 Wiki 编译")
	}

	pageIDs := make([]int64, 0, len(pages))
	for i := range pages {
		pageIDs = append(pageIDs, pages[i].ID)
	}
	refs, err := querySourceRefs(ctx, q,
		`SELECT `+sourceRefColumns+` FROM petrichor_kb_wiki_source_ref WHERE page_id = ANY($1)
		 ORDER BY page_id ASC, article_id ASC`, pageIDs)
	if err != nil {
		return nil, err
	}
	refsByPage := map[int64][]SourceRefRow{}
	articleIDSet := map[int64]struct{}{}
	for i := range refs {
		refsByPage[refs[i].PageID] = append(refsByPage[refs[i].PageID], refs[i])
		articleIDSet[refs[i].ArticleID] = struct{}{}
	}
	articles, err := loadArticlesByIDs(ctx, q, userID, articleIDSet)
	if err != nil {
		return nil, err
	}

	freshness := evaluateWikiFreshness(pages, refsByPage, articles)

	// kind=index 的页面由 bundle 根 index.md 取代，不再单独落盘。
	pathByKey := map[string]string{}
	for i := range pages {
		if pages[i].Kind == "index" {
			continue
		}
		pathByKey[pages[i].PageKey] = okfPagePath(pages[i].Kind, pages[i].PageKey)
	}

	files := make([]okfBundleFile, 0, len(pages)+2)
	for i := range pages {
		page := &pages[i]
		path, ok := pathByKey[page.PageKey]
		if !ok {
			continue
		}
		frontmatter := buildOKFFrontmatter(okfPageInput{
			Page: page, Refs: refsByPage[page.ID], Articles: articles,
			StaleSince: firstStaleSince(freshness.ReasonsByPage[page.ID]),
		})
		document, rerr := renderOKFDocument(frontmatter,
			convertWikiLinks(page.ContentMd, format, pathByKey))
		if rerr != nil {
			return nil, rerr
		}
		files = append(files, okfBundleFile{name: path, content: []byte(document)})
	}

	indexDoc, err := renderOKFIndex(kbRow, pages, pathByKey, format)
	if err != nil {
		return nil, err
	}
	files = append(files, okfBundleFile{name: "index.md", content: []byte(indexDoc)})

	logDoc, err := renderOKFLog(ctx, q, userID, kbRow.ID)
	if err != nil {
		return nil, err
	}
	files = append(files, okfBundleFile{name: "log.md", content: []byte(logDoc)})

	sort.Slice(files, func(i, j int) bool { return files[i].name < files[j].name })
	return files, nil
}

// firstStaleSince 取第一条带失效起点的原因；没有则返回 nil。
func firstStaleSince(reasons []wikiStaleReason) *time.Time {
	for i := range reasons {
		if reasons[i].StaleSince != nil {
			return reasons[i].StaleSince
		}
	}
	return nil
}

// loadArticlesByIDs 批量取源文章，用于填充 OKF sources 的标题与更新时间。
func loadArticlesByIDs(ctx context.Context, q execQuerier, userID int64, idSet map[int64]struct{}) (map[int64]*ArticleRow, error) {
	if len(idSet) == 0 {
		return map[int64]*ArticleRow{}, nil
	}
	ids := make([]int64, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	rows, err := queryArticles(ctx, q,
		`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE user_id = $1 AND id = ANY($2)`,
		userID, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]*ArticleRow, len(rows))
	for i := range rows {
		out[rows[i].ID] = &rows[i]
	}
	return out, nil
}

// okfIndexFrontmatter bundle 根 index.md 的 frontmatter，
// 按规范只声明目标版本。
type okfIndexFrontmatter struct {
	OKFVersion string `yaml:"okf_version"`
}

// renderOKFIndex 生成 bundle 清单：按页面类型分组，逐条给出链接与摘要，
// 让消费方可以渐进披露地决定读哪几页。
func renderOKFIndex(kbRow *KBRow, pages []WikiPageRow, pathByKey map[string]string, format string) (string, error) {
	groups := []struct {
		kind  string
		title string
	}{
		{"meta", "编译说明"},
		{"source", "源文档"},
		{"concept", "概念"},
		{"entity", "实体"},
		{"comparison", "对比"},
		{"answer", "问答"},
	}
	byKind := map[string][]*WikiPageRow{}
	var others []*WikiPageRow
	known := map[string]struct{}{}
	for _, group := range groups {
		known[group.kind] = struct{}{}
	}
	for i := range pages {
		page := &pages[i]
		if _, ok := pathByKey[page.PageKey]; !ok {
			continue
		}
		if _, ok := known[page.Kind]; ok {
			byKind[page.Kind] = append(byKind[page.Kind], page)
			continue
		}
		others = append(others, page)
	}

	var b strings.Builder
	b.WriteString("# " + kbRow.Name + "\n\n")
	if description := derefStr(kbRow.Description); description != "" {
		b.WriteString(description + "\n\n")
	}
	b.WriteString("由 Petrichor 从源文档编译而成的知识 bundle，遵循 Open Knowledge Format v" +
		OKFVersion + "。每个 Markdown 文件是一个概念，frontmatter 的 `sources` 指回原始文档。\n\n")

	writeGroup := func(title string, items []*WikiPageRow) {
		if len(items) == 0 {
			return
		}
		sort.Slice(items, func(i, j int) bool { return items[i].Title < items[j].Title })
		b.WriteString("## " + title + "\n\n")
		for _, page := range items {
			b.WriteString("- " + okfIndexLink(page, pathByKey, format) + " — " +
				derefOrSummarize(page.Summary, page.ContentMd, 120) + "\n")
		}
		b.WriteString("\n")
	}
	for _, group := range groups {
		writeGroup(group.title, byKind[group.kind])
	}
	writeGroup("其他页面", others)

	b.WriteString("## 使用约定\n\n")
	b.WriteString("- 源文档是唯一真源；概念页与实体页是二次综合，冲突时以 `sources` 指向的原文为准。\n")
	b.WriteString("- `status: draft` 表示该页尚未关联任何来源，引用前需要人工确认。\n")
	b.WriteString("- `log.md` 记录了这个知识库的编译与修订历史。\n")

	return renderOKFDocument(okfIndexFrontmatter{OKFVersion: OKFVersion}, b.String())
}

func okfIndexLink(page *WikiPageRow, pathByKey map[string]string, format string) string {
	if format == OKFFormatObsidian {
		return "[[" + page.PageKey + "|" + page.Title + "]]"
	}
	return "[" + markdownLabelEscaper.Replace(page.Title) + "](/" + pathByKey[page.PageKey] + ")"
}

type wikiEventRow struct {
	EventType string
	PageKey   *string
	CreatedAt time.Time
}

// renderOKFLog 用 Wiki 审计事件生成 log.md 时间线。
func renderOKFLog(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64) (string, error) {
	rows, err := q.Query(ctx,
		`SELECT e.event_type, p.page_key, e.created_at
		 FROM petrichor_kb_wiki_event_log e
		 LEFT JOIN petrichor_kb_wiki_page p ON p.id = e.page_id
		 WHERE e.user_id = $1 AND e.knowledge_base_id = $2
		 ORDER BY e.created_at DESC, e.id DESC
		 LIMIT $3`, userID, knowledgeBaseID, wikiExportEventLimit)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var events []wikiEventRow
	for rows.Next() {
		var event wikiEventRow
		if serr := rows.Scan(&event.EventType, &event.PageKey, &event.CreatedAt); serr != nil {
			return "", serr
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("# 变更历史\n\n")
	if len(events) == 0 {
		b.WriteString("暂无记录。\n")
		return b.String(), nil
	}
	b.WriteString("最近 " + strconv.Itoa(len(events)) + " 条 Wiki 编译与修订事件，由新到旧。\n\n")
	for i := range events {
		event := &events[i]
		b.WriteString("- `" + iso(event.CreatedAt) + "` **" + event.EventType + "**")
		if key := derefStr(event.PageKey); key != "" {
			b.WriteString(" — " + key)
		}
		b.WriteString("\n")
	}
	return b.String(), nil
}

// zipBundle 打包为 zip；文件顺序沿用调用方排序，保证同样输入产出同样结构。
func zipBundle(files []okfBundleFile) ([]byte, error) {
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	for _, file := range files {
		entry, err := writer.Create(file.name)
		if err != nil {
			return nil, err
		}
		if _, err := entry.Write(file.content); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
