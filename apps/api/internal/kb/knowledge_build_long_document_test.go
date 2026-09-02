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
	if len(extractionMessages) != 2 {
		t.Fatalf("候选抽取调用数 = %d，期望按 48000 字预算分成 2 批", len(extractionMessages))
	}
	allMessages := strings.Join(extractionMessages, "\n")
	for _, marker := range []string{"HEAD_MARKER", "MIDDLE_MARKER", "TAIL_MARKER"} {
		if !strings.Contains(allMessages, marker) {
			t.Fatalf("长文档分批抽取遗漏 %s", marker)
		}
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
