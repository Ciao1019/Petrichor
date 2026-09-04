package kb

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestPlanKnowledgeResolutionMergesSameConceptAndKeepsRelatedPage(t *testing.T) {
	originalInvoker := ChatInvoker
	defer func() { ChatInvoker = originalInvoker }()
	ChatInvoker = func(_ context.Context, request ChatRequest) (string, error) {
		if strings.Contains(request.Message, "文章甲") || strings.Contains(request.Message, "文章乙") {
			t.Fatalf("语义消歧不应暴露源文章名：%s", request.Message)
		}
		return `{"resolutions":[` +
			`{"pageKey":"concept-retrieval-augmented-generation","action":"merge","canonicalPageKey":"concept-rag","reason":"全称与缩写是同一概念"},` +
			`{"pageKey":"concept-vector-search","action":"keep","canonicalPageKey":"concept-vector-search"}` +
			`],"relations":[` +
			`{"fromPageKey":"concept-vector-search","toPageKey":"concept-retrieval-augmented-generation","relationType":"支撑","description":"向量检索可用于召回上下文"}` +
			`]}`, nil
	}

	current := []knowledgeCandidate{
		{kind: "concept", name: "检索增强生成", pageKey: "concept-retrieval-augmented-generation", summary: "结合检索与生成"},
		{kind: "concept", name: "向量检索", pageKey: "concept-vector-search", summary: "按向量相似度召回"},
	}
	existing := []existingKnowledgePage{{
		pageKey: "concept-rag", title: "RAG", kind: "concept",
		aliases: []string{"Retrieval-Augmented Generation"}, summary: "检索增强生成方法",
		generated: true, sourceTitles: []string{"文章甲", "文章乙"}, sourceCount: 2,
	}}
	plan, warnings := planKnowledgeResolution(
		context.Background(), 1, compileProfile{KnowledgeBaseName: "测试库"}, current, existing,
	)
	if len(warnings) != 0 {
		t.Fatalf("warnings=%v", warnings)
	}
	if plan.canonicalByKey[current[0].pageKey] != "concept-rag" {
		t.Fatalf("同一概念没有复用 canonical：%#v", plan.canonicalByKey)
	}
	if plan.canonicalByKey[current[1].pageKey] != current[1].pageKey {
		t.Fatalf("相关但不同的概念不应合并：%#v", plan.canonicalByKey)
	}
	if len(plan.relations) != 1 || plan.relations[0].fromPageKey != "concept-vector-search" ||
		plan.relations[0].toPageKey != "concept-rag" {
		t.Fatalf("跨文章关系未随 canonical 改写：%#v", plan.relations)
	}
}

func TestParseKnowledgeResolutionRejectsCrossKindMerge(t *testing.T) {
	current := []knowledgeCandidate{{kind: "entity", name: "RAG 产品", pageKey: "entity-rag-product"}}
	existing := []existingKnowledgePage{{pageKey: "concept-rag", title: "RAG", kind: "concept"}}
	edges, relations := parseKnowledgeResolution(map[string]any{
		"resolutions": []any{map[string]any{
			"pageKey": "entity-rag-product", "action": "merge", "canonicalPageKey": "concept-rag",
		}},
		"relations": []any{map[string]any{
			"fromPageKey": "entity-rag-product", "toPageKey": "concept-rag", "relationType": "实现",
		}},
	}, current, existing)
	if len(edges) != 0 {
		t.Fatalf("实体和概念不能合并：%#v", edges)
	}
	if len(relations) != 1 {
		t.Fatalf("不同类型页面仍然可以保留语义关系：%#v", relations)
	}
}

func TestPlanKnowledgeResolutionScansEveryExistingWindow(t *testing.T) {
	originalInvoker := ChatInvoker
	defer func() { ChatInvoker = originalInvoker }()
	calls := 0
	ChatInvoker = func(_ context.Context, request ChatRequest) (string, error) {
		calls++
		if strings.Contains(request.Message, "concept-existing-target") {
			return `{"resolutions":[{"pageKey":"concept-current","action":"merge","canonicalPageKey":"concept-existing-target"}],"relations":[]}`, nil
		}
		return `{"resolutions":[{"pageKey":"concept-current","action":"keep","canonicalPageKey":"concept-current"}],"relations":[]}`, nil
	}
	existing := make([]existingKnowledgePage, 0, knowledgeResolutionExistingBatchSize+1)
	for index := 0; index < knowledgeResolutionExistingBatchSize; index++ {
		existing = append(existing, existingKnowledgePage{
			pageKey: "concept-filler-" + jsonInt(index), title: "A 填充 " + jsonInt(index), kind: "concept", generated: true,
		})
	}
	existing = append(existing, existingKnowledgePage{
		pageKey: "concept-existing-target", title: "Z 最后目标", kind: "concept", generated: true,
	})
	plan, warnings := planKnowledgeResolution(
		context.Background(), 1, compileProfile{KnowledgeBaseName: "测试库"},
		[]knowledgeCandidate{{kind: "concept", name: "当前概念", pageKey: "concept-current"}}, existing,
	)
	if len(warnings) != 0 || calls != 2 {
		t.Fatalf("calls=%d warnings=%v", calls, warnings)
	}
	if plan.canonicalByKey["concept-current"] != "concept-existing-target" {
		t.Fatalf("不能只检查前 %d 个存量页面：%#v", knowledgeResolutionExistingBatchSize, plan.canonicalByKey)
	}
}

func TestBuildKnowledgeCanonicalMapPrefersExistingPageWithMoreSources(t *testing.T) {
	current := []knowledgeCandidate{{kind: "concept", pageKey: "concept-current"}}
	existing := []existingKnowledgePage{
		{pageKey: "concept-old-small", kind: "concept", generated: true, sourceCount: 1},
		{pageKey: "concept-old-main", kind: "concept", generated: true, sourceCount: 3},
	}
	mapping := buildKnowledgeCanonicalMap(current, existing, []knowledgeResolutionEdge{
		{from: "concept-current", to: "concept-old-small"},
		{from: "concept-current", to: "concept-old-main"},
	})
	for _, key := range []string{"concept-current", "concept-old-small", "concept-old-main"} {
		if mapping[key] != "concept-old-main" {
			t.Fatalf("%s canonical=%q，mapping=%#v", key, mapping[key], mapping)
		}
	}
}

func TestApplyKnowledgeResolutionCollapsesCurrentAliasesAndRelations(t *testing.T) {
	items := []extractedItem{
		{
			candidate: knowledgeCandidate{kind: "concept", name: "检索增强生成", pageKey: "concept-long", aliases: []string{"Retrieval-Augmented Generation"}},
			summary:   "结合检索和生成", contentMd: "# 检索增强生成\n\n检索外部知识后生成答案。",
		},
		{
			candidate: knowledgeCandidate{kind: "concept", name: "RAG", pageKey: "concept-rag-local"},
			summary:   "RAG 方法", contentMd: "# RAG\n\n使用召回结果增强模型回答。",
		},
	}
	existing := []existingKnowledgePage{
		{pageKey: "concept-rag", title: "RAG", kind: "concept", aliases: []string{"检索增强生成"}, generated: true},
		{pageKey: "concept-vector-search", title: "向量检索", kind: "concept", generated: true},
	}
	plan := knowledgeResolutionPlan{
		canonicalByKey: map[string]string{
			"concept-long": "concept-rag", "concept-rag-local": "concept-rag", "concept-rag": "concept-rag",
		},
		relations: []knowledgeRelation{{
			fromPageKey: "concept-long", toPageKey: "concept-vector-search", relationType: "依赖",
		}},
	}
	documentRelations := []knowledgeRelation{{
		fromPageKey: "concept-long", toPageKey: "concept-rag-local", relationType: "关联",
	}}
	resolved, candidates, relations, mergedCount := applyKnowledgeResolution(items, documentRelations, plan, existing)
	if len(resolved) != 1 || len(candidates) != 1 || mergedCount != 2 {
		t.Fatalf("resolved=%#v candidates=%#v mergedCount=%d", resolved, candidates, mergedCount)
	}
	item := resolved[0]
	if item.candidate.pageKey != "concept-rag" || item.candidate.name != "RAG" {
		t.Fatalf("没有落到已有 canonical：%#v", item.candidate)
	}
	for _, alias := range []string{"检索增强生成", "Retrieval-Augmented Generation"} {
		if !containsExactString(item.candidate.aliases, alias) {
			t.Fatalf("合并后缺少别名 %q：%#v", alias, item.candidate.aliases)
		}
	}
	if !strings.Contains(item.contentMd, "检索外部知识") || !strings.Contains(item.contentMd, "召回结果") {
		t.Fatalf("同篇文章的两份证据没有聚合：%s", item.contentMd)
	}
	if strings.Count(item.contentMd, "# RAG") != 1 {
		t.Fatalf("合并正文标题异常：%s", item.contentMd)
	}
	if len(relations) != 1 || relations[0].toPageKey != "concept-vector-search" {
		t.Fatalf("同义页之间的自关系应删除，跨页关系应保留：%#v", relations)
	}
	if !reflect.DeepEqual(item.relatedPageKeys, []string{"concept-vector-search"}) {
		t.Fatalf("relatedPageKeys=%#v", item.relatedPageKeys)
	}
}

func TestMergeKnowledgeContributionPreservesBothArticlesEvidence(t *testing.T) {
	left := map[string]any{
		"articleId": "1", "summary": "摘要甲", "contentMd": "# RAG\n\n证据甲。",
		"aliases":         []string{"RAG"},
		"relatedPageKeys": []string{"concept-vector-search"},
		"relations": []map[string]string{{
			"fromPageKey": "concept-rag-old", "toPageKey": "concept-vector-search", "relationType": "依赖",
		}},
	}
	right := map[string]any{
		"articleId": "1", "summary": "摘要乙", "contentMd": "# 检索增强生成\n\n证据乙。",
		"aliases": []string{"检索增强生成"},
	}
	merged := mergeKnowledgeContribution("RAG", left, right)
	if !strings.Contains(optString(merged["summary"]), "摘要甲") || !strings.Contains(optString(merged["summary"]), "摘要乙") {
		t.Fatalf("summary=%q", optString(merged["summary"]))
	}
	if !strings.Contains(optString(merged["contentMd"]), "证据甲") || !strings.Contains(optString(merged["contentMd"]), "证据乙") {
		t.Fatalf("contentMd=%q", optString(merged["contentMd"]))
	}
	if len(toStrSlice(merged["aliases"])) != 2 {
		t.Fatalf("aliases=%#v", merged["aliases"])
	}
}

func TestRewriteKnowledgeFrontmatterPageKeys(t *testing.T) {
	metadata := map[string]any{
		"contributions": map[string]any{
			"1": map[string]any{
				"contentMd":       "参考 [[concept-rag-old|RAG]]。",
				"relatedPageKeys": []any{"concept-rag-old"},
				"relations": []any{map[string]any{
					"fromPageKey": "concept-query", "toPageKey": "concept-rag-old", "relationType": "依赖",
				}},
			},
		},
	}
	mapping := map[string]string{"concept-rag-old": "concept-rag"}
	if !rewriteKnowledgeFrontmatterPageKeys(metadata, mapping) {
		t.Fatal("应该检测到 pageKey 改写")
	}
	entry := metadata["contributions"].(map[string]any)["1"].(map[string]any)
	if !strings.Contains(optString(entry["contentMd"]), "[[concept-rag|RAG]]") {
		t.Fatalf("contentMd=%q", optString(entry["contentMd"]))
	}
	if !reflect.DeepEqual(toStrSlice(entry["relatedPageKeys"]), []string{"concept-rag"}) {
		t.Fatalf("relatedPageKeys=%#v", entry["relatedPageKeys"])
	}
	relations := entry["relations"].([]map[string]string)
	if len(relations) != 1 || relations[0]["toPageKey"] != "concept-rag" {
		t.Fatalf("relations=%#v", relations)
	}
}

func containsExactString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
