package kb

import (
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestKnowledgeSkillSlug(t *testing.T) {
	if got := knowledgeSkillSlug("My Mac Tools", 3); got != "my-mac-tools" {
		t.Fatalf("slug = %q", got)
	}
	// 全中文名无法转写成合法 Skill 名，必须回落到稳定 ID 名。
	if got := knowledgeSkillSlug("我的知识库", 7); got != "petrichor-kb-7" {
		t.Fatalf("中文名 slug = %q", got)
	}
	if got := knowledgeSkillSlug("  ---  ", 9); got != "petrichor-kb-9" {
		t.Fatalf("空 slug 未回落：%q", got)
	}
	long := knowledgeSkillSlug(strings.Repeat("ab-", 40), 1)
	if len(long) > 48 || strings.HasSuffix(long, "-") {
		t.Fatalf("超长 slug = %q，应截断且不以连字符结尾", long)
	}
}

func newSkillPackPage(kind, key, title string, contentLen int) WikiPageRow {
	return WikiPageRow{
		ID: int64(len(key)), KnowledgeBaseID: 1, Kind: kind, PageKey: key, Title: title,
		ContentMd: strings.Repeat("x", contentLen),
	}
}

func TestSelectSkillPackPagesRanksByInboundLinks(t *testing.T) {
	pages := []WikiPageRow{
		newSkillPackPage("concept", "low", "低引用", 10),
		newSkillPackPage("concept", "high", "高引用", 10),
		newSkillPackPage("index", "index", "索引", 10),
		newSkillPackPage("source", "source-1", "源文档", 10),
	}
	inbound := map[string]int{"high": 9, "low": 1}

	selected := selectSkillPackPages(pages, inbound, false)
	if len(selected) != 2 {
		t.Fatalf("入选页面 = %d，index 应排除、source 默认不收：%#v", len(selected), selected)
	}
	if selected[0].page.PageKey != "high" {
		t.Fatalf("排序错误，首位应是入链最多的页面：%q", selected[0].page.PageKey)
	}
	if selected[0].path != "references/concepts/high.md" {
		t.Fatalf("包内路径 = %q", selected[0].path)
	}

	withSources := selectSkillPackPages(pages, inbound, true)
	if len(withSources) != 3 {
		t.Fatalf("includeSources 时应收录源文档，实际 %d 页", len(withSources))
	}
}

func TestSelectSkillPackPagesAlwaysKeepsGuideFirst(t *testing.T) {
	pages := []WikiPageRow{
		newSkillPackPage("concept", "c1", "概念", 10),
		newSkillPackPage(wikiGuideKind, WikiGuidePageKey, "编译说明书", 10),
	}
	selected := selectSkillPackPages(pages, map[string]int{"c1": 5}, false)
	if len(selected) != 2 || selected[0].page.PageKey != WikiGuidePageKey {
		t.Fatalf("编译说明书必须优先入包：%#v", selected)
	}
	if selected[0].path != "references/guides/compile-guide.md" {
		t.Fatalf("说明书路径 = %q", selected[0].path)
	}
}

func TestSelectSkillPackPagesRespectsByteBudget(t *testing.T) {
	pages := []WikiPageRow{
		newSkillPackPage("concept", "big", "超大页", skillPackMaxBytes+1),
		newSkillPackPage("concept", "small", "小页", 100),
	}
	selected := selectSkillPackPages(pages, map[string]int{"big": 99, "small": 1}, false)
	if len(selected) != 1 || selected[0].page.PageKey != "small" {
		t.Fatalf("超出字节预算的页面应跳过，且不阻断后续页面：%#v", selected)
	}
}

func TestSelectSkillPackPagesRespectsPageCap(t *testing.T) {
	pages := make([]WikiPageRow, 0, skillPackMaxPages+5)
	for i := 0; i < skillPackMaxPages+5; i++ {
		pages = append(pages, newSkillPackPage("concept", "c"+strconv.Itoa(i), "概念", 10))
	}
	if got := len(selectSkillPackPages(pages, map[string]int{}, false)); got != skillPackMaxPages {
		t.Fatalf("入选页面 = %d，期望截到 %d", got, skillPackMaxPages)
	}
}

func TestRenderSkillPackManifestShape(t *testing.T) {
	description := "macOS 命令行工具文档"
	kbRow := &KBRow{ID: 3, Name: "My Mac", Description: &description}
	selected := []skillPackPage{
		{page: ptrPage(newSkillPackPage("concept", "deep-clean", "深度清理", 10)),
			path: "references/concepts/deep-clean.md", inbound: 5},
		{page: ptrPage(newSkillPackPage("entity", "mole", "Mole", 10)),
			path: "references/entities/mole.md", inbound: 3},
	}
	manifest, err := renderSkillPackManifest(kbRow, "my-mac", selected)
	if err != nil {
		t.Fatalf("renderSkillPackManifest 出错：%v", err)
	}

	if !strings.HasPrefix(manifest, "---\nname: my-mac\ndescription: ") {
		t.Fatalf("SKILL.md frontmatter 不合规：%q", manifest[:80])
	}
	if strings.Count(manifest, "\n---\n") != 1 {
		t.Fatalf("frontmatter 分隔符数量异常")
	}
	if !strings.Contains(manifest, "涉及深度清理、Mole等主题时使用") {
		t.Fatalf("description 缺少触发主题：%q", manifest)
	}
	if !strings.Contains(manifest, "[深度清理](references/concepts/deep-clean.md)") {
		t.Fatalf("目录缺少概念页链接：%q", manifest)
	}
	if !strings.Contains(manifest, `knowledgeBaseId: "3"`) {
		t.Fatalf("在线检索说明缺少知识库 ID：%q", manifest)
	}
}

func TestRenderSkillPackIndexUsesSiblingRelativeLinks(t *testing.T) {
	kbRow := &KBRow{ID: 1, Name: "库"}
	selected := []skillPackPage{
		{page: ptrPage(newSkillPackPage("concept", "a", "甲", 10)), path: "references/concepts/a.md"},
	}
	index := renderSkillPackIndex(kbRow, selected)
	if !strings.Contains(index, "[甲](concepts/a.md)") {
		t.Fatalf("index.md 自身在 references/ 下，链接应是同级相对路径：%q", index)
	}
}

func ptrPage(page WikiPageRow) *WikiPageRow { return &page }

func TestRenderSkillPackManifestEscapesUnsafeDescription(t *testing.T) {
	// 冒号、引号和换行都会破坏手拼的 YAML；必须由序列化器处理。
	description := "工具: \"清理\" 与优化\n第二行"
	kbRow := &KBRow{ID: 1, Name: "库", Description: &description}
	manifest, err := renderSkillPackManifest(kbRow, "kb", nil)
	if err != nil {
		t.Fatalf("renderSkillPackManifest 出错：%v", err)
	}
	head := manifest[:strings.Index(manifest, "\n---\n")]
	if strings.Count(head, "\n") > 2 {
		t.Fatalf("frontmatter 被换行撑破：%q", head)
	}
	var parsed skillManifestFrontmatter
	if uerr := yaml.Unmarshal([]byte(strings.TrimPrefix(head, "---\n")), &parsed); uerr != nil {
		t.Fatalf("生成的 frontmatter 不是合法 YAML：%v\n%q", uerr, head)
	}
	if parsed.Name != "kb" || !strings.Contains(parsed.Description, `"清理"`) {
		t.Fatalf("解析结果 = %#v", parsed)
	}
}
