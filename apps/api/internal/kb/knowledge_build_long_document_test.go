package kb

import (
	"context"
	"strings"
	"sync"
	"testing"
)

func TestSplitMarkdownForKnowledgeBuildKeepsTailBeyondFormerLimit(t *testing.T) {
	sections := make([]string, 0, 140)
	for index := 0; index < 140; index++ {
		marker := "SECTION_" + jsonInt(index+1)
		if index == 139 {
			marker = "TAIL_SENTINEL"
		}
		sections = append(sections, "# 章节 "+jsonInt(index+1)+"\n\n"+marker+strings.Repeat(" 这一节的完整内容。", 80))
	}

	chunks := splitMarkdownForKnowledgeBuild(strings.Join(sections, "\n\n"), "超长文档", 0)
	if len(chunks) != 140 {
		t.Fatalf("切片数 = %d，期望 140；不能沿用旧的 120 片上限", len(chunks))
	}
	if !strings.Contains(chunks[len(chunks)-1].contentMd, "TAIL_SENTINEL") {
		t.Fatal("最后一个切片没有保留文档尾部")
	}
	if chunks[len(chunks)-1].chunkKey != "chunk-140" || chunks[len(chunks)-1].position != 139 {
		t.Fatalf("尾部切片编号错误：%s / %d", chunks[len(chunks)-1].chunkKey, chunks[len(chunks)-1].position)
	}
}

func TestExtractDocumentCandidatesCoversEveryLongDocumentChunk(t *testing.T) {
	originalInvoker := ChatInvoker
	defer func() { ChatInvoker = originalInvoker }()

	chunks := []wfChunk{
		{chunkKey: "chunk-001", position: 0, heading: "开头", contentMd: "HEAD_MARKER\n" + strings.Repeat("甲", 23_000)},
		{chunkKey: "chunk-002", position: 1, heading: "中间", contentMd: "MIDDLE_MARKER\n" + strings.Repeat("乙", 23_000)},
		{chunkKey: "chunk-003", position: 2, heading: "结尾", contentMd: "TAIL_MARKER\n" + strings.Repeat("丙", 23_000)},
	}

	var mu sync.Mutex
	extractionMessages := []string{}
	ChatInvoker = func(_ context.Context, req ChatRequest) (string, error) {
		switch req.Op {
		case "kb.build.extraction":
			mu.Lock()
			extractionMessages = append(extractionMessages, req.Message)
			mu.Unlock()
			return `{"documentSummary":"分段摘要","entities":[],"concepts":[],"relations":[]}`, nil
		case "kb.build.summary":
			return `{"documentSummary":"整篇摘要"}`, nil
		default:
			return `{}`, nil
		}
	}

	summary, _, _, warnings := extractDocumentCandidates(
		context.Background(), 1, compileProfile{}, "长文档", chunks, nil,
	)
	if summary != "整篇摘要" || len(warnings) != 0 {
		t.Fatalf("summary=%q warnings=%v", summary, warnings)
	}
	if len(extractionMessages) != 3 {
		t.Fatalf("候选抽取调用数 = %d，期望按 16000 字预算拆分超大切片", len(extractionMessages))
	}
	allMessages := strings.Join(extractionMessages, "\n")
	for _, marker := range []string{"HEAD_MARKER", "MIDDLE_MARKER", "TAIL_MARKER"} {
		if !strings.Contains(allMessages, marker) {
			t.Fatalf("长文档分批抽取遗漏 %s", marker)
		}
	}
}

func TestExtractDocumentCandidatesUsesAgentForWholeLongDocument(t *testing.T) {
	originalAgentInvoker := DocumentAgentInvoker
	originalChatInvoker := ChatInvoker
	defer func() {
		DocumentAgentInvoker = originalAgentInvoker
		ChatInvoker = originalChatInvoker
	}()

	chunks := make([]wfChunk, 0, 13)
	covered := make([]string, 0, 13)
	for index := 0; index < 13; index++ {
		key := "chunk-" + jsonInt(index+1)
		chunks = append(chunks, wfChunk{
			chunkKey: key, position: int32(index), headingPath: []string{"章节 " + jsonInt(index+1)},
			contentMd: "正文 " + jsonInt(index+1),
		})
		covered = append(covered, `"`+key+`"`)
	}

	agentCalls := 0
	DocumentAgentInvoker = func(_ context.Context, request DocumentAgentRequest) (string, error) {
		agentCalls++
		if len(request.Chunks) != len(chunks) {
			t.Fatalf("Agent 收到 %d 个切片，期望完整的 %d 个", len(request.Chunks), len(chunks))
		}
		if request.CompileGuide != "统一使用产品名称。" {
			t.Fatalf("编译说明没有传给 Agent：%q", request.CompileGuide)
		}
		return `{"documentSummary":"全文摘要","coveredChunkKeys":[` + strings.Join(covered, ",") + `],` +
			`"entities":[],"concepts":[{"name":"Agent 工作流","pageKey":"concept-agent-workflow","aliases":[],"summary":"贯穿全文","sourceChunkKeys":["chunk-1","chunk-13"]}],"relations":[]}`, nil
	}
	ChatInvoker = func(context.Context, ChatRequest) (string, error) {
		t.Fatal("长文档 Agent 成功后不应再调用旧分批抽取")
		return "", nil
	}

	summary, candidates, _, warnings := extractDocumentCandidates(
		context.Background(), 1,
		compileProfile{KnowledgeBaseName: "测试库", Guide: "# 编译说明书\n\n统一使用产品名称。"},
		"长文档", chunks, nil,
	)
	if agentCalls != 1 || summary != "全文摘要" || len(warnings) != 0 {
		t.Fatalf("agentCalls=%d summary=%q warnings=%v", agentCalls, summary, warnings)
	}
	if len(candidates) != 1 || candidates[0].pageKey != "concept-agent-workflow" {
		t.Fatalf("candidates=%#v", candidates)
	}
	if len(candidates[0].sourceChunkKeys) != 2 || candidates[0].sourceChunkKeys[1] != "chunk-13" {
		t.Fatalf("Agent 来源没有保留跨全文证据：%#v", candidates[0].sourceChunkKeys)
	}
}

func TestExtractDocumentCandidatesFallsBackWhenAgentCoverageIsInvalid(t *testing.T) {
	originalAgentInvoker := DocumentAgentInvoker
	originalChatInvoker := ChatInvoker
	defer func() {
		DocumentAgentInvoker = originalAgentInvoker
		ChatInvoker = originalChatInvoker
	}()

	chunks := make([]wfChunk, 0, 13)
	for index := 0; index < 13; index++ {
		chunks = append(chunks, wfChunk{
			chunkKey: "chunk-" + jsonInt(index+1), position: int32(index),
			contentMd: "正文 " + jsonInt(index+1),
		})
	}
	DocumentAgentInvoker = func(context.Context, DocumentAgentRequest) (string, error) {
		return `{"documentSummary":"不完整","coveredChunkKeys":["chunk-1"],"entities":[],"concepts":[],"relations":[]}`, nil
	}
	extractionCalls := 0
	ChatInvoker = func(_ context.Context, request ChatRequest) (string, error) {
		switch request.Op {
		case "kb.build.extraction":
			extractionCalls++
			return `{"documentSummary":"分段摘要","entities":[],"concepts":[],"relations":[]}`, nil
		case "kb.build.summary":
			return `{"documentSummary":"降级后的全文摘要"}`, nil
		default:
			return `{}`, nil
		}
	}

	summary, _, _, warnings := extractDocumentCandidates(
		context.Background(), 1, compileProfile{}, "长文档", chunks, nil,
	)
	if summary != "降级后的全文摘要" || extractionCalls != 2 {
		t.Fatalf("summary=%q extractionCalls=%d", summary, extractionCalls)
	}
	if len(warnings) == 0 || !strings.Contains(strings.Join(warnings, "\n"), "文档 Agent 抽取") {
		t.Fatalf("降级原因没有写入警告：%v", warnings)
	}
}

func TestExtractDocumentCandidatesUsesAgentForShortDocument(t *testing.T) {
	originalAgentInvoker := DocumentAgentInvoker
	originalChatInvoker := ChatInvoker
	defer func() {
		DocumentAgentInvoker = originalAgentInvoker
		ChatInvoker = originalChatInvoker
	}()

	agentCalls := 0
	DocumentAgentInvoker = func(_ context.Context, request DocumentAgentRequest) (string, error) {
		agentCalls++
		if len(request.Chunks) != 1 || request.Chunks[0].ChunkKey != "chunk-1" {
			t.Fatalf("短文档没有完整交给 Agent：%#v", request.Chunks)
		}
		return `{"documentSummary":"短文摘要","coveredChunkKeys":["chunk-1"],"entities":[],"concepts":[],"relations":[]}`, nil
	}
	ChatInvoker = func(context.Context, ChatRequest) (string, error) {
		t.Fatal("短文档 Agent 成功后不应再调用旧抽取路径")
		return "", nil
	}

	summary, _, _, warnings := extractDocumentCandidates(
		context.Background(), 1, compileProfile{}, "短文档",
		[]wfChunk{{chunkKey: "chunk-1", contentMd: "短文正文"}}, nil,
	)
	if agentCalls != 1 || summary != "短文摘要" || len(warnings) != 0 {
		t.Fatalf("agentCalls=%d summary=%q warnings=%v", agentCalls, summary, warnings)
	}
}

func TestMergeDocumentCandidateBatchesDoesNotPreferOnlyFront(t *testing.T) {
	batches := make([]documentCandidateBatch, 30)
	for index := range batches {
		key := "entity-item-" + jsonInt(index+1)
		batches[index].candidates = []knowledgeCandidate{{
			kind: "entity", name: "条目 " + jsonInt(index+1), pageKey: key,
			sourceChunkKeys: []string{"chunk-" + jsonInt(index+1)},
		}}
	}

	candidates, _ := mergeDocumentCandidateBatches(batches, wikiItemLimit)
	if len(candidates) != wikiItemLimit {
		t.Fatalf("候选数 = %d，期望 %d", len(candidates), wikiItemLimit)
	}
	selected := map[string]bool{}
	for _, candidate := range candidates {
		selected[candidate.pageKey] = true
	}
	for _, key := range []string{"entity-item-1", "entity-item-15", "entity-item-30"} {
		if !selected[key] {
			t.Fatalf("全局候选收敛没有覆盖 %s，仍可能偏向文档前部", key)
		}
	}
}

func TestBuildKnowledgeCandidateContextUsesReferencedTailChunk(t *testing.T) {
	chunks := []wfChunk{
		{chunkKey: "chunk-001", position: 0, heading: "开头", contentMd: "HEAD_ONLY"},
		{chunkKey: "chunk-200", position: 199, heading: "结尾", contentMd: "TAIL_ONLY"},
	}
	candidate := knowledgeCandidate{
		kind: "concept", name: "尾部知识", pageKey: "concept-tail",
		sourceChunkKeys: []string{"chunk-200"},
	}

	contextText := buildKnowledgeCandidateContext([]knowledgeCandidate{candidate}, chunks)
	if !strings.Contains(contextText, "TAIL_ONLY") {
		t.Fatal("页面物化没有读取候选对应的尾部切片")
	}
	if strings.Contains(contextText, "HEAD_ONLY") {
		t.Fatal("页面物化不应继续固定读取文档头部")
	}
}
