package kb

import (
	"strings"
	"testing"
)

func TestGuidePromptLinesEmptyWhenNoGuide(t *testing.T) {
	if lines := (compileProfile{KnowledgeBaseName: "库"}).guidePromptLines(); lines != nil {
		t.Fatalf("未配置说明书时不应注入任何内容，实际 %#v", lines)
	}
	// 只有模板注释和空标题时同样等于没配置。
	profile := compileProfile{KnowledgeBaseName: "库", Guide: wikiGuideTemplate}
	if lines := profile.guidePromptLines(); lines != nil {
		t.Fatalf("原样保存的模板不应产生规则，实际 %#v", lines)
	}
}

func TestSystemPromptKeepsBaseRulesWhenGuideAbsent(t *testing.T) {
	profile := compileProfile{KnowledgeBaseName: "库"}
	got := profile.systemPrompt("规则一", "规则二")
	if got != "规则一\n规则二" {
		t.Fatalf("systemPrompt = %q，未配置说明书时应与原提示词逐字一致", got)
	}
}

func TestSystemPromptAppendsGuideAfterBaseRules(t *testing.T) {
	profile := compileProfile{
		KnowledgeBaseName: "库",
		Guide:             "# 编译说明书\n\n## 抽取偏好\n\n- 命令抽成 concept。\n",
	}
	got := profile.systemPrompt("规则一", "只输出 JSON。")
	if !strings.HasPrefix(got, "规则一\n只输出 JSON。\n") {
		t.Fatalf("说明书必须追加在基础规则之后：%q", got)
	}
	if !strings.Contains(got, "<compile_guide>\n## 抽取偏好\n\n- 命令抽成 concept。\n</compile_guide>") {
		t.Fatalf("说明书正文未被正确包裹：%q", got)
	}
	if !strings.Contains(got, "冲突时以上述格式要求为准") {
		t.Fatalf("缺少优先级声明，自然语言可能冲掉输出契约：%q", got)
	}
	if strings.Contains(got, "# 编译说明书") {
		t.Fatalf("页面 H1 标题不应进入提示词：%q", got)
	}
}

func TestNormalizeGuideForPromptStripsCommentsAndEmptySections(t *testing.T) {
	guide := strings.Join([]string{
		"# 编译说明书",
		"",
		"## 领域与读者",
		"",
		"<!-- 例：这里是示例，不该进提示词 -->",
		"",
		"## 抽取偏好",
		"",
		"- 命令抽成 concept。",
		"",
		"## 术语表",
		"",
	}, "\n")
	got := normalizeGuideForPrompt(guide)
	if strings.Contains(got, "示例") {
		t.Fatalf("HTML 注释必须剥离：%q", got)
	}
	if strings.Contains(got, "## 领域与读者") || strings.Contains(got, "## 术语表") {
		t.Fatalf("空小节应被剔除：%q", got)
	}
	if !strings.Contains(got, "## 抽取偏好") || !strings.Contains(got, "- 命令抽成 concept。") {
		t.Fatalf("有内容的小节必须保留：%q", got)
	}
}

func TestNormalizeGuideForPromptKeepsPlainProse(t *testing.T) {
	got := normalizeGuideForPrompt("这个库是 macOS 工具文档，读者是开发者。")
	if got != "这个库是 macOS 工具文档，读者是开发者。" {
		t.Fatalf("无标题的纯正文应原样保留：%q", got)
	}
}

func TestWikiGuidePageMapsToOKFGuideDirectory(t *testing.T) {
	if got := okfPagePath(wikiGuideKind, WikiGuidePageKey); got != "guides/compile-guide.md" {
		t.Fatalf("编译说明书导出路径 = %q", got)
	}
	page := &WikiPageRow{
		KnowledgeBaseID: 1, PageKey: WikiGuidePageKey, Title: wikiGuideTitle, Kind: wikiGuideKind,
		ContentMd: "## 抽取偏好\n\n- 命令抽成 concept。",
	}
	fm := buildOKFFrontmatter(okfPageInput{Page: page})
	if fm.Type != "Guide" {
		t.Fatalf("type = %q，期望 Guide", fm.Type)
	}
	// 说明书没有来源引用，但它是人写的配置，不该被判成 draft。
	if fm.Status != okfStatusStable {
		t.Fatalf("status = %q，编译说明书应为 stable", fm.Status)
	}
}
