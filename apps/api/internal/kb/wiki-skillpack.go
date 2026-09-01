// wiki-skillpack.go POST /api/kb/wiki/skill-pack：把一个知识库蒸馏成可分发的
// Agent Skill 包（zip），解压后放进 Claude Code / Codex 的 skills 目录即可使用。
//
// 和 /api/agent/skill-pack 的区别：那个装的是「怎么调 Petrichor 的 API」，
// 这个装的是知识本身——SKILL.md 给出领域说明与目录，references/ 是按引用度
// 挑出来的 Wiki 页面正文，带 OKF frontmatter，sources 指回源文档。
package kb

import (
	"context"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	// skillPackMaxPages 单个 Skill 包最多收录的页面数。
	skillPackMaxPages = 60
	// skillPackMaxBytes 正文总量上限：Skill 会被整体读进模型上下文，不能无限大。
	skillPackMaxBytes = 1 << 21 // 2 MiB
	// skillPackTocPerKind 目录里每种页面类型最多列出的条数。
	skillPackTocPerKind = 40
)

// WikiSkillPack 导出知识库 Skill 包。
func WikiSkillPack(c *ginContext) {
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
		includeSources := raw["includeSources"] == true
		q := pool()
		ctx := c.Request.Context()
		kbRow, err := assertKnowledgeBaseOwner(ctx, q, user.ID, kbID)
		if err != nil {
			return nil, err
		}
		files, slug, err := buildKnowledgeSkillPack(ctx, q, user.ID, kbRow, includeSources)
		if err != nil {
			return nil, err
		}
		archive, err := zipBundle(files)
		if err != nil {
			return nil, err
		}
		c.Header("Cache-Control", "no-store")
		c.Header("Content-Disposition", `attachment; filename="`+slug+`-skill.zip"`)
		c.Data(http.StatusOK, "application/zip", archive)
		return nil, nil
	})
}

// skillSlugUnsafe Skill 名必须是小写字母、数字和连字符。
var skillSlugUnsafe = regexp.MustCompile(`[^a-z0-9]+`)

// knowledgeSkillSlug 由知识库名生成 Skill 名；全中文等无法转写时回落到稳定 ID 名。
func knowledgeSkillSlug(name string, knowledgeBaseID int64) string {
	slug := strings.Trim(skillSlugUnsafe.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(slug) < 2 {
		return "petrichor-kb-" + strconv.FormatInt(knowledgeBaseID, 10)
	}
	if len(slug) > 48 {
		slug = strings.Trim(slug[:48], "-")
	}
	return slug
}

// skillPackPage 入选 Skill 包的页面及其在包内的相对路径。
type skillPackPage struct {
	page    *WikiPageRow
	path    string
	inbound int
}

// buildKnowledgeSkillPack 组装 Skill 包文件列表，返回文件与 Skill 名。
func buildKnowledgeSkillPack(
	ctx context.Context, q execQuerier, userID int64, kbRow *KBRow, includeSources bool,
) ([]okfBundleFile, string, error) {
	pages, err := loadWikiPageRows(ctx, q, userID, kbRow.ID)
	if err != nil {
		return nil, "", err
	}
	if len(pages) == 0 {
		return nil, "", badReq("这个知识库还没有编译出 Wiki 页面，先执行一次 Wiki 编译")
	}
	inbound, err := loadWikiInboundLinkCounts(ctx, q, userID, kbRow.ID)
	if err != nil {
		return nil, "", err
	}

	selected := selectSkillPackPages(pages, inbound, includeSources)
	if len(selected) == 0 {
		return nil, "", badReq("这个知识库还没有可分发的概念或实体页面")
	}

	// 页面正文按引用关系互链，路径映射要覆盖全部入选页，未入选的保持原样 wikilink。
	pathByKey := make(map[string]string, len(selected))
	for i := range selected {
		pathByKey[selected[i].page.PageKey] = selected[i].path
	}

	slug := knowledgeSkillSlug(kbRow.Name, kbRow.ID)
	files := make([]okfBundleFile, 0, len(selected)+2)

	pageIDs := make([]int64, 0, len(selected))
	for i := range selected {
		pageIDs = append(pageIDs, selected[i].page.ID)
	}
	refs, err := querySourceRefs(ctx, q,
		`SELECT `+sourceRefColumns+` FROM petrichor_kb_wiki_source_ref WHERE page_id = ANY($1)
		 ORDER BY page_id ASC, article_id ASC`, pageIDs)
	if err != nil {
		return nil, "", err
	}
	refsByPage := map[int64][]SourceRefRow{}
	articleIDs := map[int64]struct{}{}
	for i := range refs {
		refsByPage[refs[i].PageID] = append(refsByPage[refs[i].PageID], refs[i])
		articleIDs[refs[i].ArticleID] = struct{}{}
	}
	articles, err := loadArticlesByIDs(ctx, q, userID, articleIDs)
	if err != nil {
		return nil, "", err
	}
	freshness := evaluateWikiFreshness(pages, refsByPage, articles)

	for i := range selected {
		page := selected[i].page
		frontmatter := buildOKFFrontmatter(okfPageInput{
			Page: page, Refs: refsByPage[page.ID], Articles: articles,
			StaleSince: firstStaleSince(freshness.ReasonsByPage[page.ID]),
		})
		document, rerr := renderOKFDocument(frontmatter,
			convertWikiLinks(page.ContentMd, OKFFormatOKF, pathByKey))
		if rerr != nil {
			return nil, "", rerr
		}
		files = append(files, okfBundleFile{
			name:    slug + "/" + selected[i].path,
			content: []byte(document),
		})
	}

	files = append(files, okfBundleFile{
		name:    slug + "/references/index.md",
		content: []byte(renderSkillPackIndex(kbRow, selected)),
	})
	manifest, err := renderSkillPackManifest(kbRow, slug, selected)
	if err != nil {
		return nil, "", err
	}
	files = append(files, okfBundleFile{name: slug + "/SKILL.md", content: []byte(manifest)})

	sort.Slice(files, func(i, j int) bool { return files[i].name < files[j].name })
	return files, slug, nil
}

// loadWikiInboundLinkCounts 每个 page_key 的入链数，用来衡量页面在知识网络里的中心度。
func loadWikiInboundLinkCounts(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64) (map[string]int, error) {
	rows, err := q.Query(ctx,
		`SELECT to_page_key, COUNT(*) FROM petrichor_kb_wiki_link
		 WHERE user_id = $1 AND knowledge_base_id = $2 GROUP BY to_page_key`,
		userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int{}
	for rows.Next() {
		var key string
		var count int
		if err := rows.Scan(&key, &count); err != nil {
			return nil, err
		}
		counts[key] = count
	}
	return counts, rows.Err()
}

// selectSkillPackPages 挑选入包页面：编译说明书必选，其余按入链数降序、
// 同分按标题排序，受页数与字节预算双重约束。
func selectSkillPackPages(pages []WikiPageRow, inbound map[string]int, includeSources bool) []skillPackPage {
	var guide *WikiPageRow
	candidates := make([]skillPackPage, 0, len(pages))
	for i := range pages {
		page := &pages[i]
		switch page.Kind {
		case "index":
			// 索引由 references/index.md 重新生成，不收原页面。
			continue
		case wikiGuideKind:
			guide = page
			continue
		case "source":
			if !includeSources {
				continue
			}
		}
		candidates = append(candidates, skillPackPage{page: page, inbound: inbound[page.PageKey]})
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].inbound != candidates[j].inbound {
			return candidates[i].inbound > candidates[j].inbound
		}
		return candidates[i].page.Title < candidates[j].page.Title
	})

	selected := make([]skillPackPage, 0, skillPackMaxPages+1)
	budget := skillPackMaxBytes
	if guide != nil {
		selected = append(selected, skillPackPage{
			page: guide, path: "references/" + okfPagePath(guide.Kind, guide.PageKey),
		})
		budget -= len(guide.ContentMd)
	}
	for i := range candidates {
		if len(selected) >= skillPackMaxPages {
			break
		}
		size := len(candidates[i].page.ContentMd)
		if budget-size < 0 {
			continue
		}
		budget -= size
		candidates[i].path = "references/" + okfPagePath(candidates[i].page.Kind, candidates[i].page.PageKey)
		selected = append(selected, candidates[i])
	}
	return selected
}

// skillManifestFrontmatter SKILL.md 的 YAML 头。
// 知识库名和描述都是用户输入，可能含冒号、引号或换行，必须走序列化器而不是手拼。
type skillManifestFrontmatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
}

// renderSkillPackManifest 生成 SKILL.md：frontmatter + 领域说明 + 用法 + 在线检索入口。
func renderSkillPackManifest(kbRow *KBRow, slug string, selected []skillPackPage) (string, error) {
	byKind := map[string][]skillPackPage{}
	for _, item := range selected {
		byKind[item.page.Kind] = append(byKind[item.page.Kind], item)
	}
	topics := skillPackTopicList(byKind, 12)

	description := strings.TrimSpace(derefStr(kbRow.Description))
	if description == "" {
		description = kbRow.Name + " 知识库"
	}
	trigger := description
	if len(topics) > 0 {
		trigger += "。涉及" + strings.Join(topics, "、") + "等主题时使用"
	}

	var b strings.Builder
	b.WriteString("# " + kbRow.Name + "\n\n")
	if desc := strings.TrimSpace(derefStr(kbRow.Description)); desc != "" {
		b.WriteString(desc + "\n\n")
	}
	b.WriteString("由 Petrichor 从源文档编译而成，收录 " + strconv.Itoa(len(selected)) +
		" 个页面。每个页面遵循 Open Knowledge Format v" + OKFVersion +
		"，frontmatter 的 `sources` 指回原始文档。\n\n")

	b.WriteString("## 怎么用\n\n")
	b.WriteString("1. 先读 `references/index.md`，按目录定位相关页面。\n")
	b.WriteString("2. 再读具体页面正文；页面之间用相对路径互链，可以顺着链接继续展开。\n")
	b.WriteString("3. 页面 frontmatter 里 `status: draft` 表示尚未关联来源，引用前需人工确认；" +
		"`stale_after` 早于当前时间表示源文档已更新、这页可能过时。\n")
	b.WriteString("4. 这里只有编译沉淀的知识层。需要原文细节或最新内容时，走下面的在线接口。\n\n")

	b.WriteString("## 目录\n\n")
	writeKindSection(&b, "概念", byKind["concept"])
	writeKindSection(&b, "实体", byKind["entity"])
	writeKindSection(&b, "对比", byKind["comparison"])
	writeKindSection(&b, "问答", byKind["answer"])
	writeKindSection(&b, "源文档", byKind["source"])
	writeKindSection(&b, "编译说明", byKind[wikiGuideKind])

	b.WriteString("## 在线检索（可选）\n\n")
	b.WriteString("需要 Petrichor Agent API Key，请求头 `Authorization: Bearer $PETRICHOR_AGENT_KEY`：\n\n")
	b.WriteString("| 用途 | 接口 |\n| --- | --- |\n")
	b.WriteString("| 语义检索原文 | `POST " + skillPackBaseURL() + "/api/agent/document/semantic-search` |\n")
	b.WriteString("| 基于原文问答 | `POST " + skillPackBaseURL() + "/api/agent/document/qa` |\n")
	b.WriteString("| 读取最新 Wiki 页面 | `POST " + skillPackBaseURL() + "/api/agent/wiki/page/detail` |\n\n")
	b.WriteString("请求体统一带 `knowledgeBaseId: \"" + strconv.FormatInt(kbRow.ID, 10) + "\"`。\n")

	return renderOKFDocument(skillManifestFrontmatter{
		Name:        slug,
		Description: strings.Join(strings.Fields(trigger), " "),
	}, b.String())
}

func writeKindSection(b *strings.Builder, title string, items []skillPackPage) {
	if len(items) == 0 {
		return
	}
	b.WriteString("### " + title + "\n\n")
	for i, item := range items {
		if i >= skillPackTocPerKind {
			b.WriteString("- 其余 " + strconv.Itoa(len(items)-skillPackTocPerKind) +
				" 页见 `references/index.md`\n")
			break
		}
		b.WriteString("- [" + markdownLabelEscaper.Replace(item.page.Title) + "](" + item.path + ")" +
			" — " + derefOrSummarize(item.page.Summary, item.page.ContentMd, 100) + "\n")
	}
	b.WriteString("\n")
}

// skillPackTopicList 取入链最多的若干页面标题，作为 Skill description 的触发词。
func skillPackTopicList(byKind map[string][]skillPackPage, limit int) []string {
	pool := append(append([]skillPackPage{}, byKind["concept"]...), byKind["entity"]...)
	sort.SliceStable(pool, func(i, j int) bool { return pool[i].inbound > pool[j].inbound })
	topics := make([]string, 0, limit)
	for i := range pool {
		if len(topics) >= limit {
			break
		}
		if title := strings.TrimSpace(pool[i].page.Title); title != "" {
			topics = append(topics, title)
		}
	}
	return topics
}

// renderSkillPackIndex references/index.md：全部入包页面的完整清单。
func renderSkillPackIndex(kbRow *KBRow, selected []skillPackPage) string {
	ordered := append([]skillPackPage(nil), selected...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].page.Kind != ordered[j].page.Kind {
			return ordered[i].page.Kind < ordered[j].page.Kind
		}
		return ordered[i].page.Title < ordered[j].page.Title
	})

	var b strings.Builder
	b.WriteString("# " + kbRow.Name + " 页面索引\n\n")
	b.WriteString("共 " + strconv.Itoa(len(ordered)) + " 个页面，按类型和标题排序。\n\n")
	currentKind := ""
	for _, item := range ordered {
		if item.page.Kind != currentKind {
			currentKind = item.page.Kind
			b.WriteString("\n## " + skillPackKindLabel(currentKind) + "\n\n")
		}
		// index.md 自身在 references/ 下，链接用同级相对路径。
		relative := strings.TrimPrefix(item.path, "references/")
		b.WriteString("- [" + markdownLabelEscaper.Replace(item.page.Title) + "](" + relative + ")" +
			" — " + derefOrSummarize(item.page.Summary, item.page.ContentMd, 140) + "\n")
	}
	return b.String()
}

func skillPackKindLabel(kind string) string {
	labels := map[string]string{
		"concept": "概念", "entity": "实体", "comparison": "对比",
		"answer": "问答", "source": "源文档", wikiGuideKind: "编译说明",
	}
	if label, ok := labels[kind]; ok {
		return label
	}
	return kind
}

// skillPackBaseURL 站点公开地址；未配置时留占位，让使用者自己替换。
func skillPackBaseURL() string {
	if base := strings.TrimRight(strings.TrimSpace(configBaseURL()), "/"); base != "" {
		return base
	}
	return "$PETRICHOR_BASE_URL"
}
