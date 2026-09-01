package kb

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func TestOKFSafeFileNameBlocksTraversalAndReservedNames(t *testing.T) {
	if got := okfSafeFileName("../../etc/passwd"); strings.Contains(got, "/") || strings.Contains(got, "..") {
		t.Fatalf("okfSafeFileName = %q，不能保留路径分隔符或上跳段", got)
	}
	if got := okfSafeFileName("index"); got != "page-index" {
		t.Fatalf("okfSafeFileName(index) = %q，OKF 根保留名必须让位", got)
	}
	if got := okfSafeFileName("log"); got != "page-log" {
		t.Fatalf("okfSafeFileName(log) = %q，OKF 根保留名必须让位", got)
	}
	if got := okfSafeFileName("知识图谱-v2"); got != "知识图谱-v2" {
		t.Fatalf("okfSafeFileName 中文键 = %q，期望原样保留", got)
	}
	if got := okfSafeFileName("   "); got != "page" {
		t.Fatalf("okfSafeFileName(空) = %q，期望回落 page", got)
	}
	long := strings.Repeat("检索", 200)
	if got := []rune(okfSafeFileName(long)); len(got) != 120 {
		t.Fatalf("okfSafeFileName 长度 = %d，期望截断到 120", len(got))
	}
}

func TestOKFPagePathRoutesByKind(t *testing.T) {
	cases := map[string]string{
		"source":     "sources/rag.md",
		"concept":    "concepts/rag.md",
		"entity":     "entities/rag.md",
		"comparison": "comparisons/rag.md",
		"answer":     "answers/rag.md",
		"log":        "logs/rag.md",
		"meta":       "guides/rag.md",
		"unknown":    "pages/rag.md",
	}
	for kind, want := range cases {
		if got := okfPagePath(kind, "rag"); got != want {
			t.Fatalf("okfPagePath(%s) = %q，期望 %q", kind, got, want)
		}
	}
}

func TestConvertWikiLinksOKFAndObsidian(t *testing.T) {
	paths := map[string]string{"rag": "concepts/rag.md", "向量库": "entities/向量库.md"}
	content := "见 [[rag]] 与 [[向量库|向量数据库]]，以及 [[missing|缺失页]]。"

	okf := convertWikiLinks(content, OKFFormatOKF, paths)
	if !strings.Contains(okf, "[rag](/concepts/rag.md)") {
		t.Fatalf("okf 输出缺少无标签链接改写：%s", okf)
	}
	if !strings.Contains(okf, "[向量数据库](/entities/向量库.md)") {
		t.Fatalf("okf 输出缺少带标签链接改写：%s", okf)
	}
	if !strings.Contains(okf, "[[missing|缺失页]]") {
		t.Fatalf("解析不到的 page key 必须原样保留，实际：%s", okf)
	}

	if got := convertWikiLinks(content, OKFFormatObsidian, paths); got != content {
		t.Fatalf("obsidian 格式必须原样返回，实际：%s", got)
	}
}

func TestConvertWikiLinksEscapesBracketsInLabel(t *testing.T) {
	got := convertWikiLinks("[[rag|检索[增强]生成]]", OKFFormatOKF,
		map[string]string{"rag": "concepts/rag.md"})
	if !strings.Contains(got, `[检索\[增强\]生成](/concepts/rag.md)`) {
		t.Fatalf("标签内方括号必须转义，实际：%s", got)
	}
}
func TestConvertWikiLinksDoesNotSwallowAcrossLinks(t *testing.T) {
	paths := map[string]string{"a": "concepts/a.md", "b": "concepts/b.md"}
	got := convertWikiLinks("[[a|甲]] 中间文字 [[b|乙]]", OKFFormatOKF, paths)
	if got != "[甲](/concepts/a.md) 中间文字 [乙](/concepts/b.md)" {
		t.Fatalf("相邻链接被吞并：%s", got)
	}

	// 未闭合的 wikilink 不能跨行把后续内容吞成标签。
	unclosed := convertWikiLinks("[[a|甲\n下一行 [[b]]", OKFFormatOKF, paths)
	if !strings.HasPrefix(unclosed, "[[a|甲\n") {
		t.Fatalf("未闭合链接应原样保留：%q", unclosed)
	}
	if !strings.HasSuffix(unclosed, "[b](/concepts/b.md)") {
		t.Fatalf("下一行的完整链接仍应被改写：%q", unclosed)
	}
}

func TestBuildOKFFrontmatterDerivesTypeStatusAndSources(t *testing.T) {
	now := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC)
	frontmatter := `{"generatedBy":"article-knowledge-build","buildVersion":4,"sourceHash":"abc",` +
		`"categoryPath":["检索"],"aliases":["RAG","检索增强"]}`
	page := &WikiPageRow{
		ID: 7, KnowledgeBaseID: 3, PageKey: "rag", Title: "检索增强生成", Kind: "concept",
		ContentMd: "# 检索增强生成\n\n正文", FrontmatterJson: &frontmatter,
		ContentHash: "hash7", Version: 2, UpdatedAt: now,
	}
	note := "构建知识：RAG 综述"
	refs := []SourceRefRow{{PageID: 7, ArticleID: 11, Note: &note}}
	articles := map[int64]*ArticleRow{11: {ID: 11, Title: "RAG 综述", UpdatedAt: now}}

	fm := buildOKFFrontmatter(okfPageInput{Page: page, Refs: refs, Articles: articles})

	if fm.Type != "Concept" {
		t.Fatalf("type = %q，期望 Concept", fm.Type)
	}
	if fm.Status != okfStatusStable {
		t.Fatalf("status = %q，有来源引用的页面期望 stable", fm.Status)
	}
	if fm.Generated == nil || fm.Generated.By != "petrichor/article-knowledge-build" {
		t.Fatalf("generated = %#v，期望带构建来源", fm.Generated)
	}
	if len(fm.Sources) != 1 || fm.Sources[0].Title != "RAG 综述" {
		t.Fatalf("sources = %#v，期望回填源文章标题", fm.Sources)
	}
	if !strings.HasSuffix(fm.Sources[0].Resource, "/dashboard/knowledge/3/articles/11") {
		t.Fatalf("resource = %q，期望指向源文章路由", fm.Sources[0].Resource)
	}
	wantTags := []string{"检索", "RAG", "检索增强"}
	if len(fm.Tags) != len(wantTags) {
		t.Fatalf("tags = %#v，期望分类路径与别名合并", fm.Tags)
	}
	for i, tag := range wantTags {
		if fm.Tags[i] != tag {
			t.Fatalf("tags[%d] = %q，期望 %q", i, fm.Tags[i], tag)
		}
	}
	if fm.Petrichor == nil || fm.Petrichor.BuildVersion != 4 || fm.Petrichor.SourceHash != "abc" {
		t.Fatalf("x_petrichor = %#v，期望保留构建元数据", fm.Petrichor)
	}
}

func TestBuildOKFFrontmatterMarksUnsourcedPageDraft(t *testing.T) {
	page := &WikiPageRow{
		KnowledgeBaseID: 1, PageKey: "orphan", Title: "孤页", Kind: "concept",
		ContentMd: "正文", UpdatedAt: time.Now(),
	}
	if got := buildOKFFrontmatter(okfPageInput{Page: page}).Status; got != okfStatusDraft {
		t.Fatalf("status = %q，无来源引用期望 draft", got)
	}

	archivedAt := time.Now()
	page.ArchivedAt = &archivedAt
	if got := buildOKFFrontmatter(okfPageInput{Page: page}).Status; got != okfStatusDeprecated {
		t.Fatalf("status = %q，归档页面期望 deprecated", got)
	}
}

func TestBuildOKFFrontmatterHonoursStoredOverrides(t *testing.T) {
	frontmatter := `{"staleAfter":"2026-12-01T00:00:00.000Z","okfStatus":"deprecated"}`
	page := &WikiPageRow{
		KnowledgeBaseID: 1, PageKey: "x", Title: "X", Kind: "concept",
		ContentMd: "正文", FrontmatterJson: &frontmatter, UpdatedAt: time.Now(),
	}
	fm := buildOKFFrontmatter(okfPageInput{Page: page})
	if fm.StaleAfter != "2026-12-01T00:00:00.000Z" {
		t.Fatalf("stale_after = %q，期望取自 frontmatter", fm.StaleAfter)
	}
	if fm.Status != okfStatusDeprecated {
		t.Fatalf("status = %q，期望被 frontmatter 覆写", fm.Status)
	}
}

func TestRenderOKFDocumentEmitsFrontmatterBlock(t *testing.T) {
	document, err := renderOKFDocument(okfFrontmatter{
		Type: "Concept", Title: "检索增强生成", Description: "摘要", Status: okfStatusStable,
	}, "  # 正文\n\n段落  ")
	if err != nil {
		t.Fatalf("renderOKFDocument 出错：%v", err)
	}
	if !strings.HasPrefix(document, "---\ntype: Concept\n") {
		t.Fatalf("frontmatter 必须以 type 开头，实际：%q", document)
	}
	if strings.Count(document, "\n---\n") != 1 {
		t.Fatalf("frontmatter 分隔符数量异常：%q", document)
	}
	body := document[strings.Index(document, "\n---\n")+len("\n---\n"):]
	if strings.TrimSpace(body) != "# 正文\n\n段落" {
		t.Fatalf("正文 = %q，期望去掉首尾空白", body)
	}
	if !strings.HasSuffix(document, "\n") {
		t.Fatal("文档必须以换行结尾")
	}
}

func TestRenderOKFDocumentOmitsEmptyOptionalFields(t *testing.T) {
	document, err := renderOKFDocument(okfFrontmatter{Type: "Entity"}, "正文")
	if err != nil {
		t.Fatalf("renderOKFDocument 出错：%v", err)
	}
	for _, field := range []string{"title:", "description:", "tags:", "generated:", "sources:", "x_petrichor:"} {
		if strings.Contains(document, field) {
			t.Fatalf("空可选字段 %s 不应出现在 frontmatter：%q", field, document)
		}
	}
}

func TestRenderOKFIndexGroupsPagesByKind(t *testing.T) {
	summary := "概念摘要"
	pages := []WikiPageRow{
		{PageKey: "rag", Title: "检索增强生成", Kind: "concept", Summary: &summary, ContentMd: "正文"},
		{PageKey: "source-1", Title: "RAG 综述", Kind: "source", ContentMd: "源文档正文"},
		{PageKey: "index", Title: "索引", Kind: "index", ContentMd: "旧索引"},
	}
	paths := map[string]string{"rag": "concepts/rag.md", "source-1": "sources/source-1.md"}
	description := "检索相关资料"
	kbRow := &KBRow{ID: 3, Name: "检索知识库", Description: &description}

	document, err := renderOKFIndex(kbRow, pages, paths, OKFFormatOKF)
	if err != nil {
		t.Fatalf("renderOKFIndex 出错：%v", err)
	}
	if !strings.HasPrefix(document, "---\nokf_version: \""+OKFVersion+"\"\n---\n") {
		t.Fatalf("index.md 必须声明 okf_version，实际：%q", document)
	}
	if !strings.Contains(document, "[检索增强生成](/concepts/rag.md)") {
		t.Fatalf("index.md 缺少概念页链接：%s", document)
	}
	if !strings.Contains(document, "[RAG 综述](/sources/source-1.md)") {
		t.Fatalf("index.md 缺少源文档链接：%s", document)
	}
	if strings.Contains(document, "旧索引") {
		t.Fatalf("kind=index 页面已被 bundle 清单取代，不应再出现：%s", document)
	}
	if !strings.Contains(document, description) {
		t.Fatalf("index.md 应带上知识库描述：%s", document)
	}
}

func TestRenderOKFIndexKeepsWikilinksForObsidian(t *testing.T) {
	pages := []WikiPageRow{{PageKey: "rag", Title: "检索增强生成", Kind: "concept", ContentMd: "正文"}}
	paths := map[string]string{"rag": "concepts/rag.md"}
	document, err := renderOKFIndex(&KBRow{ID: 1, Name: "库"}, pages, paths, OKFFormatObsidian)
	if err != nil {
		t.Fatalf("renderOKFIndex 出错：%v", err)
	}
	if !strings.Contains(document, "[[rag|检索增强生成]]") {
		t.Fatalf("obsidian 格式必须输出 wikilink：%s", document)
	}
}

func TestParseOKFFormatDefaultsAndRejectsUnknown(t *testing.T) {
	if got, err := parseOKFFormat(nil); err != nil || got != OKFFormatOKF {
		t.Fatalf("parseOKFFormat(nil) = %q, %v，期望默认 okf", got, err)
	}
	if got, err := parseOKFFormat(" Obsidian "); err != nil || got != OKFFormatObsidian {
		t.Fatalf("parseOKFFormat 大小写/空白容错失败：%q, %v", got, err)
	}
	if _, err := parseOKFFormat("json"); err == nil {
		t.Fatal("未知 format 必须报错")
	}
}

func TestZipBundleRoundTrip(t *testing.T) {
	archive, err := zipBundle([]okfBundleFile{
		{name: "index.md", content: []byte("清单")},
		{name: "concepts/rag.md", content: []byte("概念")},
	})
	if err != nil {
		t.Fatalf("zipBundle 出错：%v", err)
	}
	if len(archive) == 0 {
		t.Fatal("zip 内容不能为空")
	}
	names := zipEntryNames(t, archive)
	if len(names) != 2 || names["index.md"] != "清单" || names["concepts/rag.md"] != "概念" {
		t.Fatalf("zip 条目 = %#v", names)
	}
}

// zipEntryNames 解开 zip 并返回「条目名 → 内容」，只用于断言 bundle 结构。
func zipEntryNames(t *testing.T, archive []byte) map[string]string {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("读取 zip 失败：%v", err)
	}
	out := map[string]string{}
	for _, file := range reader.File {
		handle, oerr := file.Open()
		if oerr != nil {
			t.Fatalf("打开 zip 条目 %s 失败：%v", file.Name, oerr)
		}
		content, rerr := io.ReadAll(handle)
		handle.Close()
		if rerr != nil {
			t.Fatalf("读取 zip 条目 %s 失败：%v", file.Name, rerr)
		}
		out[file.Name] = string(content)
	}
	return out
}

func TestBuildOKFFrontmatterWritesStaleAfterFromFreshness(t *testing.T) {
	compiledAt := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	staleSince := time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
	page := &WikiPageRow{
		KnowledgeBaseID: 1, PageKey: "rag", Title: "RAG", Kind: "concept",
		ContentMd: "正文", UpdatedAt: compiledAt,
	}
	fm := buildOKFFrontmatter(okfPageInput{Page: page, StaleSince: &staleSince})
	if fm.StaleAfter != iso(staleSince) {
		t.Fatalf("stale_after = %q，期望源文档更新时间 %q", fm.StaleAfter, iso(staleSince))
	}

	// frontmatter 里的显式覆写优先级更高。
	stored := `{"staleAfter":"2026-01-01T00:00:00.000Z"}`
	page.FrontmatterJson = &stored
	if got := buildOKFFrontmatter(okfPageInput{Page: page, StaleSince: &staleSince}).StaleAfter; got != "2026-01-01T00:00:00.000Z" {
		t.Fatalf("stale_after = %q，显式覆写应优先", got)
	}
}
