package kb

import (
	"testing"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

func spanRow(spanID, parent, name, kind, status string, started *time.Time) *ent.KBDocumentSpan {
	row := &ent.KBDocumentSpan{SpanID: spanID, Name: name, Kind: kind, Status: status, StartedAt: started}
	if parent != "" {
		value := parent
		row.ParentSpanID = &value
	}
	return row
}

func TestBuildSpanTreeAssemblesParentChild(t *testing.T) {
	now := time.Now()
	rows := []*ent.KBDocumentSpan{
		spanRow("root", "", "document_processing", SpanKindRoot, SpanStatusRunning, &now),
		spanRow("ext", "root", StageExtract, SpanKindStage, SpanStatusDone, &now),
		spanRow("mm", "root", StageMultimodal, SpanKindStage, SpanStatusRunning, &now),
		spanRow("img0", "mm", "multimodal.page[0]", SpanKindGeneration, SpanStatusRunning, &now),
	}

	tree, currentStage, failure := buildSpanTree(rows, "processing")
	if tree == nil || tree.SpanID != "root" {
		t.Fatalf("根节点应为 root，实际 %#v", tree)
	}
	if currentStage != StageMultimodal {
		t.Fatalf("正在跑的阶段应为 multimodal，实际 %q", currentStage)
	}
	if failure != nil {
		t.Fatalf("没有失败 span 时不应返回失败，实际 %#v", failure)
	}

	// 六个主流程阶段必须齐全，没跑到的补成占位节点，否则时间线会缺段。
	byName := map[string]string{}
	for _, child := range tree.Children {
		if child.Kind == SpanKindStage {
			byName[child.Name] = child.Status
		}
	}
	for _, stage := range AllPipelineStages {
		if _, ok := byName[stage]; !ok {
			t.Fatalf("阶段 %s 缺失", stage)
		}
	}
	if byName[StageExtract] != SpanStatusDone {
		t.Fatalf("文档解析阶段状态应为 done，实际 %q", byName[StageExtract])
	}
	if byName[StagePostFinish] != SpanStatusPending {
		t.Fatalf("未开始的阶段应补成 pending，实际 %q", byName[StagePostFinish])
	}

	// 子任务必须挂在多模态阶段下，而不是散到根上。
	var multimodal *SpanNode
	for _, child := range tree.Children {
		if child.Name == StageMultimodal {
			multimodal = child
		}
	}
	if multimodal == nil || len(multimodal.Children) != 1 {
		t.Fatalf("多模态阶段应有 1 个子任务，实际 %#v", multimodal)
	}
	if multimodal.Children[0].Name != "multimodal.page[0]" {
		t.Fatalf("子任务名不对：%q", multimodal.Children[0].Name)
	}
}

func TestBuildSpanTreeOrdersStagesCanonically(t *testing.T) {
	now := time.Now()
	rows := []*ent.KBDocumentSpan{
		spanRow("root", "", "document_processing", SpanKindRoot, SpanStatusDone, &now),
		spanRow("post", "root", StagePostFinish, SpanKindStage, SpanStatusDone, &now),
		spanRow("ext", "root", StageExtract, SpanKindStage, SpanStatusDone, &now),
	}
	tree, _, _ := buildSpanTree(rows, "ready")
	for index, stage := range AllPipelineStages {
		if tree.Children[index].Name != stage {
			t.Fatalf("第 %d 个阶段应为 %s，实际 %s", index, stage, tree.Children[index].Name)
		}
	}
}

// 历史文档没有 span 行，占位状态要跟着文档自身的状态走，
// 否则已经解析完的老文档会永远显示成"六段都在等待"。
func TestBuildSpanTreeInfersPlaceholderFromDocumentStatus(t *testing.T) {
	tree, _, _ := buildSpanTree(nil, "ready")
	if tree.Status != SpanStatusDone {
		t.Fatalf("已完成文档的合成根应为 done，实际 %q", tree.Status)
	}
	for _, child := range tree.Children {
		if child.Status != SpanStatusDone || !child.Placeholder {
			t.Fatalf("占位阶段状态异常：%#v", child)
		}
	}
}

func TestBuildSpanTreeReportsFailure(t *testing.T) {
	now := time.Now()
	rows := []*ent.KBDocumentSpan{
		spanRow("root", "", "document_processing", SpanKindRoot, SpanStatusFailed, &now),
		spanRow("chunk", "root", StageChunking, SpanKindStage, SpanStatusFailed, &now),
	}
	_, _, failure := buildSpanTree(rows, "failed")
	if failure == nil || failure.Name != StageChunking {
		t.Fatalf("应报告分块阶段失败，实际 %#v", failure)
	}
}

func TestStagesDependingOnReturnsTransitiveClosure(t *testing.T) {
	got := stagesDependingOn(StageChunking)
	want := map[string]bool{StageEmbedding: true, StageMultimodal: true, StagePostFinish: true, StageWiki: true}
	if len(got) != len(want) {
		t.Fatalf("分块的下游应有 %d 个，实际 %#v", len(want), got)
	}
	for _, stage := range got {
		if !want[stage] {
			t.Fatalf("%s 不是分块的下游", stage)
		}
	}
	if got := stagesDependingOn(StagePostFinish); len(got) != 1 || got[0] != StageWiki {
		t.Fatalf("后处理的下游应只有 Wiki，实际 %#v", got)
	}
	if len(stagesDependingOn(StageWiki)) != 0 {
		t.Fatal("Wiki 是末端阶段，不应有下游")
	}
}

func TestAttachWikiStageMapsRunningJobProgress(t *testing.T) {
	now := time.Now().UTC()
	tree, _, _ := buildSpanTree(nil, "ready")
	job := &ent.KBWikiIngestJob{
		ID: 9, Status: "running", Phase: "reducing", DocumentIdsJSON: "[3]",
		TotalDocuments: 1, ProcessedDocuments: 1, TotalPages: 55, ProcessedPages: 25,
		CreatedAt: now.Add(-time.Minute), StartedAt: &now, WarningsJSON: "[]",
	}
	currentStage, failure := attachWikiStage(tree, "ready", job, "", nil)
	if currentStage != StageWiki || failure != nil {
		t.Fatalf("运行中的 Wiki 状态异常：stage=%q failure=%#v", currentStage, failure)
	}
	var wiki *SpanNode
	for _, child := range tree.Children {
		if child.Name == StageWiki {
			wiki = child
			break
		}
	}
	if wiki == nil || wiki.Status != SpanStatusRunning || wiki.Placeholder {
		t.Fatalf("Wiki 阶段应映射为真实运行节点，实际 %#v", wiki)
	}
	output, ok := wiki.Output.(map[string]any)
	if !ok || output["processedPages"] != 25 {
		t.Fatalf("Wiki 进度输出异常：%#v", wiki.Output)
	}
}
