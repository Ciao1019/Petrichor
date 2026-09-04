package kb

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestKnowledgeTaxonomyStageOutcomeMarksFallbackAsFailed(t *testing.T) {
	status, message := knowledgeTaxonomyStageOutcome([]string{"模型结果不是有效 JSON"})
	if status != knowledgeBuildStageFailed || !strings.Contains(message, "未完成") {
		t.Fatalf("status=%q message=%q", status, message)
	}
	status, _ = knowledgeTaxonomyStageOutcome(nil)
	if status != knowledgeBuildStageCompleted {
		t.Fatalf("无警告时 status=%q", status)
	}
}

func TestNormalizeKnowledgeCategoryPathAcceptsDatabaseStringSlice(t *testing.T) {
	cases := []struct {
		name  string
		value any
		want  []string
	}{
		{name: "数据库字符串数组", value: []string{"软件与工具", "系统工具"}, want: []string{"软件与工具", "系统工具"}},
		{name: "模型通用数组", value: []any{"软件与工具", "系统工具"}, want: []string{"软件与工具", "系统工具"}},
		{name: "拆分内嵌分隔符", value: []string{"软件与工具/系统工具"}, want: []string{"软件与工具", "系统工具"}},
		{name: "过滤类型目录", value: []string{"实体", "系统工具"}, want: []string{"系统工具"}},
		{name: "路径去重", value: "软件与工具 / 软件与工具", want: []string{"软件与工具"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeKnowledgeCategoryPath(tc.value); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("normalizeKnowledgeCategoryPath(%#v) = %#v，期望 %#v", tc.value, got, tc.want)
			}
		})
	}
}

func TestPlanKnowledgeTaxonomyKeepsVersionedExistingCategory(t *testing.T) {
	originalInvoker := ChatInvoker
	defer func() { ChatInvoker = originalInvoker }()
	calls := 0
	ChatInvoker = func(context.Context, ChatRequest) (string, error) {
		calls++
		return `{"assignments":[]}`, nil
	}

	candidates, updates, warnings := planKnowledgeTaxonomy(
		context.Background(), 1, compileProfile{KnowledgeBaseName: "测试库"}, "Fastfetch 使用说明",
		[]knowledgeCandidate{{kind: "entity", name: "Fastfetch", pageKey: "entity-fastfetch"}},
		[]existingKnowledgePage{{
			pageKey: "entity-fastfetch", title: "Fastfetch", kind: "entity",
			categoryPath:    []string{"软件与工具", "系统工具"},
			taxonomyVersion: ArticleKnowledgeTaxonomyVersion, generated: true,
		}},
	)
	if calls != 0 {
		t.Fatalf("已有当前版本目录时不应再次调用模型，实际调用 %d 次", calls)
	}
	if len(warnings) != 0 || len(updates) != 0 {
		t.Fatalf("warnings=%v updates=%v", warnings, updates)
	}
	if got := candidates[0].categoryPath; !reflect.DeepEqual(got, []string{"软件与工具", "系统工具"}) {
		t.Fatalf("未复用数据库中的 []string 目录：%#v", got)
	}
}

func TestPlanKnowledgeTaxonomyReplansLegacyPagesAcrossSources(t *testing.T) {
	originalInvoker := ChatInvoker
	defer func() { ChatInvoker = originalInvoker }()
	var request ChatRequest
	ChatInvoker = func(_ context.Context, current ChatRequest) (string, error) {
		request = current
		return `{"assignments":[` +
			`{"pageKey":"entity-fastfetch","path":["软件与工具","系统工具"]},` +
			`{"pageKey":"entity-mole","path":["软件与工具","系统工具"]},` +
			`{"pageKey":"concept-deep-clean","path":["系统维护"]}` +
			`]}`, nil
	}

	candidates, updates, warnings := planKnowledgeTaxonomy(
		context.Background(), 1, compileProfile{KnowledgeBaseName: "测试库"}, "Fastfetch 使用说明",
		[]knowledgeCandidate{{kind: "entity", name: "Fastfetch", pageKey: "entity-fastfetch", summary: "系统信息工具"}},
		[]existingKnowledgePage{
			{
				pageKey: "entity-mole", title: "Mole", kind: "entity", summary: "系统清理工具",
				categoryPath: []string{"工具与安装"}, generated: true, sourceTitles: []string{"小鼹鼠"},
			},
			{
				pageKey: "concept-deep-clean", title: "深度清理", kind: "concept", summary: "清理机制",
				categoryPath: []string{"核心功能"}, generated: true, sourceTitles: []string{"小鼹鼠"},
			},
		},
	)
	if len(warnings) != 0 {
		t.Fatalf("全局目录规划不应降级：%v", warnings)
	}
	if got := candidates[0].categoryPath; !reflect.DeepEqual(got, []string{"软件与工具", "系统工具"}) {
		t.Fatalf("当前页面分类 = %#v", got)
	}
	if !reflect.DeepEqual(updates["entity-mole"], []string{"软件与工具", "系统工具"}) ||
		!reflect.DeepEqual(updates["concept-deep-clean"], []string{"系统维护"}) {
		t.Fatalf("存量页面未进入同一次全局重整：%#v", updates)
	}
	if strings.Contains(request.Message, "Fastfetch 使用说明") || strings.Contains(request.Message, "小鼹鼠") {
		t.Fatalf("目录提示不应向模型暴露源文件名：%s", request.Message)
	}
	if strings.Contains(request.Message, "工具与安装") || strings.Contains(request.Message, "核心功能") {
		t.Fatalf("旧版按文档章节生成的目录不应作为复用锚点：%s", request.Message)
	}
	for _, pageKey := range []string{"entity-fastfetch", "entity-mole", "concept-deep-clean"} {
		if !strings.Contains(request.Message, pageKey) {
			t.Fatalf("全局规划提示缺少页面 %s：%s", pageKey, request.Message)
		}
	}
}

func TestPlanKnowledgeTaxonomyFeedsStableFoldersToNewPages(t *testing.T) {
	originalInvoker := ChatInvoker
	defer func() { ChatInvoker = originalInvoker }()
	ChatInvoker = func(_ context.Context, request ChatRequest) (string, error) {
		if !strings.Contains(request.Message, "- 软件与工具\n  - 系统工具") {
			t.Fatalf("没有把存量稳定目录作为跨文档复用锚点：%s", request.Message)
		}
		return `{"assignments":[{"pageKey":"entity-neofetch","path":["软件与工具","系统工具"]}]}`, nil
	}

	candidates, _, warnings := planKnowledgeTaxonomy(
		context.Background(), 1, compileProfile{KnowledgeBaseName: "测试库"}, "Neofetch 手册",
		[]knowledgeCandidate{{kind: "entity", name: "Neofetch", pageKey: "entity-neofetch"}},
		[]existingKnowledgePage{{
			pageKey: "entity-fastfetch", title: "Fastfetch", kind: "entity",
			categoryPath:    []string{"软件与工具", "系统工具"},
			taxonomyVersion: ArticleKnowledgeTaxonomyVersion, generated: true,
		}},
	)
	if len(warnings) != 0 || !reflect.DeepEqual(candidates[0].categoryPath, []string{"软件与工具", "系统工具"}) {
		t.Fatalf("candidates=%#v warnings=%v", candidates, warnings)
	}
}

func TestKnowledgeTaxonomyRejectsProductFolderSharedByOneSource(t *testing.T) {
	items := []knowledgeTaxonomyItem{
		{candidate: knowledgeCandidate{kind: "entity", name: "Mole", pageKey: "entity-mole"}, sourceTitles: []string{"小鼹鼠"}},
		{candidate: knowledgeCandidate{kind: "concept", name: "深度清理", pageKey: "concept-deep-clean"}, sourceTitles: []string{"小鼹鼠"}},
	}
	if validKnowledgeTaxonomyPath(items[1], items, []string{"Mole"}) {
		t.Fatal("同来源产品名不能成为该文件其他页面的目录")
	}
	if !validKnowledgeTaxonomyPath(items[1], items, []string{"系统维护"}) {
		t.Fatal("稳定语义目录不应被误拒绝")
	}
}

func TestKnowledgeTaxonomyAllowsDifferentArticlesToShareSemanticFolder(t *testing.T) {
	items := []knowledgeTaxonomyItem{
		{
			candidate:    knowledgeCandidate{kind: "concept", name: "Mole 安装、更新与卸载", pageKey: "concept-mole-installation"},
			sourceTitles: []string{"Mole 手册"},
		},
		{
			candidate:    knowledgeCandidate{kind: "concept", name: "Fastfetch 安装方法", pageKey: "concept-fastfetch-installation"},
			sourceTitles: []string{"Fastfetch 手册"},
		},
	}
	path := []string{"软件管理", "安装与分发"}
	for _, item := range items {
		if !validKnowledgeTaxonomyPath(item, items, path) {
			t.Fatalf("不同文章的相关 Wiki 页面应该能够共享语义目录：%#v", item)
		}
	}
}

func TestPlanKnowledgeTaxonomyRejectsDocumentFoldersAndOnePagePerFolder(t *testing.T) {
	originalInvoker := ChatInvoker
	defer func() { ChatInvoker = originalInvoker }()
	ChatInvoker = func(context.Context, ChatRequest) (string, error) {
		return `{"assignments":[` +
			`{"pageKey":"entity-fastfetch","path":["Fastfetch"]},` +
			`{"pageKey":"concept-config","path":["配置指南"]},` +
			`{"pageKey":"concept-format","path":["格式字符串"]},` +
			`{"pageKey":"concept-logo","path":["Logo 自定义"]}` +
			`]}`, nil
	}
	items := []knowledgeTaxonomyItem{
		{candidate: knowledgeCandidate{kind: "entity", name: "Fastfetch", pageKey: "entity-fastfetch"}, sourceTitles: []string{"Fastfetch 使用说明"}},
		{candidate: knowledgeCandidate{kind: "concept", name: "配置文件", pageKey: "concept-config"}, sourceTitles: []string{"Fastfetch 使用说明"}},
		{candidate: knowledgeCandidate{kind: "concept", name: "格式字符串", pageKey: "concept-format"}, sourceTitles: []string{"Fastfetch 使用说明"}},
		{candidate: knowledgeCandidate{kind: "concept", name: "Logo 自定义", pageKey: "concept-logo"}, sourceTitles: []string{"Fastfetch 使用说明"}},
	}
	planned, warnings := planKnowledgeTaxonomyItems(
		context.Background(), 1, compileProfile{KnowledgeBaseName: "测试库"}, items, nil,
	)
	if len(planned) != 0 {
		t.Fatalf("文件名、章节名或一页一目录结果必须整体拒绝：%#v", planned)
	}
	if len(warnings) == 0 {
		t.Fatal("拒绝无效目录后必须返回可见告警")
	}
}

func TestPlanKnowledgeTaxonomyRejectsUniqueFolderForEveryPage(t *testing.T) {
	originalInvoker := ChatInvoker
	defer func() { ChatInvoker = originalInvoker }()
	ChatInvoker = func(context.Context, ChatRequest) (string, error) {
		return `{"assignments":[` +
			`{"pageKey":"concept-a","path":["主题甲"]},` +
			`{"pageKey":"concept-b","path":["主题乙"]},` +
			`{"pageKey":"concept-c","path":["主题丙"]},` +
			`{"pageKey":"concept-d","path":["主题丁"]}` +
			`]}`, nil
	}
	items := []knowledgeTaxonomyItem{
		{candidate: knowledgeCandidate{kind: "concept", name: "知识 A", pageKey: "concept-a"}},
		{candidate: knowledgeCandidate{kind: "concept", name: "知识 B", pageKey: "concept-b"}},
		{candidate: knowledgeCandidate{kind: "concept", name: "知识 C", pageKey: "concept-c"}},
		{candidate: knowledgeCandidate{kind: "concept", name: "知识 D", pageKey: "concept-d"}},
	}
	planned, warnings := planKnowledgeTaxonomyItems(
		context.Background(), 1, compileProfile{KnowledgeBaseName: "测试库"}, items, nil,
	)
	if len(planned) != 0 || len(warnings) == 0 || !strings.Contains(warnings[0], "一页一目录") {
		t.Fatalf("planned=%#v warnings=%v", planned, warnings)
	}
}

func TestBalanceKnowledgeTaxonomyItemsRoundRobinsSources(t *testing.T) {
	items := []knowledgeTaxonomyItem{
		{candidate: knowledgeCandidate{pageKey: "a-1"}, sourceTitles: []string{"A"}},
		{candidate: knowledgeCandidate{pageKey: "a-2"}, sourceTitles: []string{"A"}},
		{candidate: knowledgeCandidate{pageKey: "b-1"}, sourceTitles: []string{"B"}},
		{candidate: knowledgeCandidate{pageKey: "b-2"}, sourceTitles: []string{"B"}},
	}
	got := balanceKnowledgeTaxonomyItems(items)
	keys := make([]string, 0, len(got))
	for _, item := range got {
		keys = append(keys, item.candidate.pageKey)
	}
	if !reflect.DeepEqual(keys, []string{"a-1", "b-1", "a-2", "b-2"}) {
		t.Fatalf("来源轮询顺序 = %#v", keys)
	}
}
