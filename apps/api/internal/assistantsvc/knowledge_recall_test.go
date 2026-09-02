package assistantsvc

import (
	"encoding/json"
	"strings"
	"testing"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func recallTestHit(kbID, articleID, chunkID int64, title, content string, score float64) chunkHit {
	return chunkHit{
		KnowledgeBaseID: kbID,
		ArticleID:       articleID,
		ChunkID:         chunkID,
		Title:           title,
		Snippet:         content,
		Content:         content,
		Score:           score,
	}
}

func TestBuildKnowledgeQueriesRewritesComplexQuestion(t *testing.T) {
	queries, rewritten := buildKnowledgeQueries("请比较 Redis 的持久化方案，以及说明各自适用场景和恢复差异", nil)
	if len(queries) < 3 {
		t.Fatalf("复杂问题没有拆成独立召回意图: %#v", queries)
	}
	if len(rewritten) != len(queries)-1 {
		t.Fatalf("诊断子查询与实际查询不一致: queries=%#v rewritten=%#v", queries, rewritten)
	}
	if queries[0] != "请比较 Redis 的持久化方案，以及说明各自适用场景和恢复差异" {
		t.Fatalf("主查询被改写覆盖: %#v", queries)
	}
}

func TestBuildKnowledgeQueriesKeepsSimpleQuestionSingle(t *testing.T) {
	queries, rewritten := buildKnowledgeQueries("Redis 怎么部署", nil)
	if len(queries) != 1 || len(rewritten) != 0 {
		t.Fatalf("简单问题不应增加检索成本: queries=%#v rewritten=%#v", queries, rewritten)
	}
}

func TestRankKnowledgeBM25UsesFieldWeights(t *testing.T) {
	documents := []knowledgeBM25Document{
		{
			Hit:     recallTestHit(1, 1, 1, "Redis 消费幂等", "处理重复消费", 0),
			Title:   "Redis 消费幂等",
			Content: "处理重复消费",
		},
		{
			Hit:     recallTestHit(1, 2, 2, "消息记录", "Redis 消费幂等 Redis 消费幂等", 0),
			Title:   "消息记录",
			Content: "Redis 消费幂等 Redis 消费幂等",
		},
	}

	hits := rankKnowledgeBM25(documents, "Redis 消费幂等", 2)
	if len(hits) != 2 {
		t.Fatalf("BM25 命中数错误: %#v", hits)
	}
	if hits[0].ChunkID != 1 {
		t.Fatalf("标题权重没有生效，首条=%#v", hits[0])
	}
	if hits[0].Score <= 0 || hits[1].Score <= 0 {
		t.Fatalf("BM25 分数无效: %#v", hits)
	}
}

func TestFuseKnowledgeHitsRewardsIndependentSources(t *testing.T) {
	a := recallTestHit(1, 1, 1, "A", "A", 0.9)
	a.RecallSources = []string{"chunk_vector"}
	b := recallTestHit(1, 2, 2, "B", "B", 0.8)
	b.RecallSources = []string{"chunk_vector"}
	bAgain := b
	bAgain.RecallSources = []string{"chunk_bm25"}

	hits := fuseKnowledgeHits([][]chunkHit{{a, b}, {bAgain}}, 10)
	if len(hits) != 2 || hits[0].ChunkID != 2 {
		t.Fatalf("多路共同命中没有获得更高 RRF 排名: %#v", hits)
	}
	if len(hits[0].RecallSources) != 2 {
		t.Fatalf("召回来源未合并: %#v", hits[0].RecallSources)
	}
}

func TestFuseKnowledgeHitsPrefersOriginalChunkMetadata(t *testing.T) {
	question := recallTestHit(1, 1, 1, "部署", "用户问法：怎么安装", 0.9)
	question.RecallSources = []string{"question_vector"}
	direct := recallTestHit(1, 1, 1, "安装步骤", "下载安装并启动", 0.8)
	direct.RecallSources = []string{"chunk_bm25"}

	hits := fuseKnowledgeHits([][]chunkHit{{question}, {direct}}, 10)
	if len(hits) != 1 || hits[0].Snippet != "下载安装并启动" || hits[0].Title != "安装步骤" {
		t.Fatalf("推荐问题元数据遮住了原文分片: %#v", hits)
	}
	if len(hits[0].RecallSources) != 2 {
		t.Fatalf("替换展示元数据时丢失了召回贡献: %#v", hits[0].RecallSources)
	}
}

func TestSelectKnowledgeArticleStageBalancesArticles(t *testing.T) {
	hits := []chunkHit{
		recallTestHit(1, 10, 1, "A1", "a1", 0.9),
		recallTestHit(1, 10, 2, "A2", "a2", 0.8),
		recallTestHit(1, 10, 3, "A3", "a3", 0.7),
		recallTestHit(1, 20, 4, "B1", "b1", 0.75),
		recallTestHit(1, 20, 5, "B2", "b2", 0.6),
	}
	selected, articles := selectKnowledgeArticleStage(hits, 2, 2)
	if len(articles) != 2 || len(selected) != 4 {
		t.Fatalf("文章阶段数量错误: articles=%#v selected=%#v", articles, selected)
	}
	if selected[0].ArticleID == selected[1].ArticleID {
		t.Fatalf("章节没有按文章轮询，长文章会刷屏: %#v", selected)
	}
}

func TestRerankKnowledgeLocallyUsesOriginalQuestion(t *testing.T) {
	hits := []chunkHit{
		recallTestHit(1, 1, 1, "部署说明", "普通部署步骤", 0.2),
		recallTestHit(1, 2, 2, "Redis Sentinel 故障转移", "哨兵切换主节点", 0.1),
	}
	reranked := rerankKnowledgeLocally("Redis Sentinel 故障转移", hits)
	if reranked[0].ChunkID != 2 {
		t.Fatalf("本地重排没有把直接回答问题的章节提到首位: %#v", reranked)
	}
	if reranked[0].RerankScore == nil {
		t.Fatal("重排分数未写入诊断字段")
	}
}

func TestSelectDiverseKnowledgeHitsDropsDuplicates(t *testing.T) {
	first := recallTestHit(1, 1, 1, "安装步骤", "下载安装并启动服务", 0.9)
	duplicate := recallTestHit(1, 2, 2, "安装步骤", "下载安装并启动服务", 0.8)
	unique := recallTestHit(1, 3, 3, "故障处理", "检查连接与日志", 0.7)

	selected, dropped := selectDiverseKnowledgeHits([]chunkHit{first, duplicate, unique}, 3, 3)
	if len(selected) != 2 || len(dropped) != 1 {
		t.Fatalf("重复章节未过滤: selected=%#v dropped=%#v", selected, dropped)
	}
	if selected[1].ChunkID != 3 {
		t.Fatalf("多样性过滤误伤不同内容: %#v", selected)
	}
}

func TestKnowledgeDiagnosticsMatchesTSContract(t *testing.T) {
	diagnostics := knowledgeRecallDiagnostics{
		Query: "Redis", RewrittenQueries: []string{"Redis 部署"},
		ChunkVectorKeys: []string{"chunk:1:1"}, QuestionBM25Keys: []string{"chunk:1:2"},
		FusionKeys: []string{"chunk:1:1"}, FinalKeys: []string{"chunk:1:1"},
		SelectedArticleIDs: []string{"1:1"}, RetrievalScope: "article_then_chapter",
		Degraded: map[string]string{}, RetrievalMs: 12, RerankMs: 1,
	}
	value := diagnostics.toMap(true)
	for _, key := range []string{
		"rewrittenQueries", "chunkVectorKeys", "questionVectorKeys", "chunkBm25Keys",
		"questionBm25Keys", "wikiKeys", "fusionKeys", "finalKeys", "selectedArticleIds",
		"diversityDroppedKeys", "rerankApplied", "rerankStrategy", "retrievalScope",
	} {
		if _, exists := value[key]; !exists {
			t.Fatalf("缺少 TS 检索诊断字段 %q: %#v", key, value)
		}
	}
	if value["rerankStrategy"] != "local" {
		t.Fatalf("诊断不应再伪装成 rrf_local: %#v", value)
	}
}

func TestNormalizeSearchOutputKeepsCandidateContract(t *testing.T) {
	normalized := normalizeSearchOutput(map[string]any{
		"mode": "hybrid",
		"hits": []map[string]any{{
			"knowledgeBaseId": "1", "articleId": "2", "chunkId": "3",
			"title": "部署", "path": "指南 › 部署", "summary": "正文摘要",
			"score": 0.9, "rerankScore": 12.0, "recallSources": []string{"chunk_vector"},
		}},
		"diagnostics": map[string]any{
			"chunkVectorKeys": []string{"chunk:1:3"}, "rerankStrategy": "local",
		},
	}, nil)
	if normalized.Progress == nil || !*normalized.Progress {
		t.Fatalf("候选召回不应被标记为无进展: %#v", normalized)
	}
	var data struct {
		Mode string           `json:"mode"`
		Hits []map[string]any `json:"hits"`
	}
	if err := json.Unmarshal(normalized.Data, &data); err != nil {
		t.Fatal(err)
	}
	if data.Mode != "hybrid" || len(data.Hits) != 1 || data.Hits[0]["chunkId"] != "3" {
		t.Fatalf("候选结构与 TS 契约不一致: %#v", data)
	}
	if _, leaked := data.Hits[0]["rerankScore"]; leaked {
		t.Fatalf("排名诊断不应重复进入模型 Observation: %#v", data.Hits[0])
	}
}

func TestNormalizeSearchOutputSuggestsRewriteWhenEmpty(t *testing.T) {
	normalized := normalizeSearchOutput(map[string]any{
		"mode": "hybrid", "hits": []map[string]any{},
	}, nil)
	if normalized.Progress == nil || *normalized.Progress {
		t.Fatalf("空召回被错误标记为进展: %#v", normalized)
	}
	if len(normalized.SuggestedActions) != 2 || normalized.SuggestedActions[0] != "rewrite_query" {
		t.Fatalf("空召回没有引导改写/外部研究: %#v", normalized.SuggestedActions)
	}
}

func TestSelectKnowledgeLookupReadTargetsIncludesWikiDetail(t *testing.T) {
	hits := []map[string]any{
		{"chunkId": "20", "title": "最相关章节"},
		{"chunkId": "14", "title": "次相关章节"},
		{"chunkId": "21", "title": "另一章节"},
		{"pageKey": "entity-mole", "title": "Mole"},
	}
	selected := selectKnowledgeLookupReadTargets(hits, 2)
	if len(selected) != 2 || selected[0]["chunkId"] != "20" || selected[1]["pageKey"] != "entity-mole" {
		t.Fatalf("lookup 没有在最高相关章节之外补读 Wiki 详情: %#v", selected)
	}

	wikiFirst := selectKnowledgeLookupReadTargets([]map[string]any{
		{"pageKey": "entity-mole", "title": "Mole"},
		{"chunkId": "20", "title": "最相关章节"},
	}, 2)
	if len(wikiFirst) != 2 || wikiFirst[0]["pageKey"] != "entity-mole" || wikiFirst[1]["chunkId"] != "20" {
		t.Fatalf("Wiki 已排第一时不应重复选择或丢掉普通章节: %#v", wikiFirst)
	}
}

func TestNormalizeLookupOutputPreservesWikiPagesForAnswerMentions(t *testing.T) {
	normalized := normalizeLookupOutput(map[string]any{
		"mode": "hybrid",
		"hits": []map[string]any{{
			"knowledgeBaseId": "1", "pageKey": "entity-mole", "title": "Mole",
		}},
		"reads": []map[string]any{{
			"kind": "wiki_page", "pageKind": "entity", "pageKey": "entity-mole",
			"title": "Mole", "aliases": []string{"小鼹鼠"}, "content": "Mole 是 macOS 清理工具。",
			"links": []map[string]any{
				{"pageKey": "entity-cleanmymac", "title": "CleanMyMac", "kind": "entity"},
				{"pageKey": "entity-homebrew", "title": "Homebrew", "kind": "entity"},
				{"pageKey": "entity-terminal", "title": "终端", "kind": "entity"},
				{"pageKey": "concept-deep-clean", "title": "深度清理", "kind": "concept"},
				{"pageKey": "concept-smart-uninstall", "title": "智能卸载", "kind": "concept"},
				{"pageKey": "concept-system-monitor", "title": "系统监控", "kind": "concept"},
			},
			"inLinks": []map[string]any{
				{"pageKey": "entity-appcleaner", "title": "AppCleaner", "kind": "entity"},
				// 重复关联页应合并，不能让前端收到两份同 pageKey target。
				{"pageKey": "entity-homebrew", "title": "Homebrew", "kind": "entity", "aliases": []string{"brew"}},
			},
		}},
	}, nil)

	var data struct {
		Pages []wikiMentionObservationPage `json:"pages"`
	}
	if err := json.Unmarshal(normalized.Data, &data); err != nil {
		t.Fatal(err)
	}
	wantKeys := []string{
		"entity-mole", "entity-cleanmymac", "entity-homebrew", "entity-terminal",
		"concept-deep-clean", "concept-smart-uninstall", "concept-system-monitor", "entity-appcleaner",
	}
	if len(data.Pages) != len(wantKeys) {
		t.Fatalf("Wiki 当前页及关联页在 lookup 归一化时丢失: %#v", data.Pages)
	}
	for _, key := range wantKeys {
		found := false
		for _, page := range data.Pages {
			if page.PageKey == key {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("归一化结果缺少 Wiki 页面 %q: %#v", key, data.Pages)
		}
	}

	observations := rt.NewObservationStore()
	observations.Add(rt.CreateObservation(
		"tool_result", "knowledge.lookup", normalized.Summary, normalized.Data,
		nil, nil, false, 1,
	))
	targets := rt.CollectWikiMentionTargets(observations, nil)
	answer := "[[entity-mole|Mole]] 可搭配 CleanMyMac、Homebrew 和终端。\n\n| 功能 | 说明 |\n| --- | --- |\n| 深度清理 | 清缓存 |\n| 智能卸载 | 删除残留 |\n| 系统监控 | 查看状态 |"
	annotated := rt.AnnotateNormalQaWikiMentions(answer, targets)
	for _, mention := range []string{
		"[[entity-mole|Mole]]", "[[entity-cleanmymac|CleanMyMac]]", "[[entity-homebrew|Homebrew]]",
		"[[entity-terminal|终端]]", "[[concept-deep-clean|深度清理]]",
		"[[concept-smart-uninstall|智能卸载]]", "[[concept-system-monitor|系统监控]]",
	} {
		if !strings.Contains(annotated, mention) {
			t.Fatalf("最终答案缺少 Wiki 波浪线 %q:\n%s", mention, annotated)
		}
	}
	if strings.Count(annotated, "[[entity-mole|Mole]]") != 1 {
		t.Fatalf("模型已有的显式 Wiki 链接不应被改写或重复: %s", annotated)
	}
}

func TestNormalizeWikiPageReadPreservesNeighborPages(t *testing.T) {
	normalized := normalizeWikiPageRead(map[string]any{
		"pageKey": "entity-mole", "title": "Mole", "kind": "entity",
		"aliases": []string{"小鼹鼠"}, "contentMd": "Mole 是清理工具。",
		"links": []map[string]any{{
			"pageKey": "entity-homebrew", "title": "Homebrew", "kind": "entity", "aliases": []string{"brew"},
		}},
		"inLinks": []map[string]any{{
			"pageKey": "concept-deep-clean", "title": "深度清理", "kind": "concept",
		}},
	}, nil)

	var data struct {
		Pages []wikiMentionObservationPage `json:"pages"`
	}
	if err := json.Unmarshal(normalized.Data, &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Pages) != 3 || data.Pages[1].PageKey != "entity-homebrew" || data.Pages[1].Aliases[0] != "brew" {
		t.Fatalf("Wiki 直接深读的关联页词典不完整: %#v", data.Pages)
	}
}
