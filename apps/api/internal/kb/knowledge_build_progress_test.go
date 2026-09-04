package kb

import (
	"fmt"
	"testing"
	"time"
)

func TestKnowledgeBuildProgressTracksParallelAnalysis(t *testing.T) {
	startedAt := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	writer := newKnowledgeBuildTaskProgressWriter(nil, startedAt, 2, 3)
	writer.report(knowledgeBuildProgress{
		Percent: 5, Phase: knowledgeBuildPhaseAnalyzing,
		Message: "正在分析正文并生成推荐问题",
	})
	writer.reportStage(knowledgeBuildStageUpdate{
		ParentID: knowledgeBuildPhaseAnalyzing,
		ID:       knowledgeBuildStageAgent, Status: knowledgeBuildStageRunning,
		Message: "已读取 2/4 个正文分卷", Percent: 50, Completed: 2, Total: 4,
	})
	writer.reportStage(knowledgeBuildStageUpdate{
		ParentID: knowledgeBuildPhaseAnalyzing,
		ID:       knowledgeBuildStageQuestions, Status: knowledgeBuildStageCompleted,
		Message: "推荐问题生成完成", Percent: 100, Completed: 3, Total: 3,
	})

	progress := writer.snapshot()
	if progress.Attempt != 2 || progress.MaxAttempts != 3 {
		t.Fatalf("attempt=%d maxAttempts=%d", progress.Attempt, progress.MaxAttempts)
	}
	if progress.Percent != 30 {
		t.Fatalf("percent=%d，期望按并行子阶段权重得到 30", progress.Percent)
	}
	analyzing := findKnowledgeBuildStage(progress.Stages, "", knowledgeBuildPhaseAnalyzing)
	if analyzing == nil || analyzing.Status != knowledgeBuildStageRunning {
		t.Fatalf("analyzing=%#v", analyzing)
	}
	agent := findKnowledgeBuildStage(progress.Stages, knowledgeBuildPhaseAnalyzing, knowledgeBuildStageAgent)
	questions := findKnowledgeBuildStage(progress.Stages, knowledgeBuildPhaseAnalyzing, knowledgeBuildStageQuestions)
	if agent == nil || agent.Completed != 2 || agent.Total != 4 || agent.Percent != 50 {
		t.Fatalf("agent=%#v", agent)
	}
	if questions == nil || questions.Status != knowledgeBuildStageCompleted || questions.Percent != 100 {
		t.Fatalf("questions=%#v", questions)
	}
}

func TestKnowledgeBuildProgressFailureStopsActiveChildren(t *testing.T) {
	writer := newKnowledgeBuildTaskProgressWriter(nil, time.Now().UTC(), 1, 3)
	writer.report(knowledgeBuildProgress{
		Percent: 5, Phase: knowledgeBuildPhaseAnalyzing, Message: "开始分析",
	})
	writer.reportStage(knowledgeBuildStageUpdate{
		ParentID: knowledgeBuildPhaseAnalyzing,
		ID:       knowledgeBuildStageAgent, Status: knowledgeBuildStageRunning,
		Message: "阅读全文", Percent: 40,
	})
	writer.report(knowledgeBuildProgress{
		Percent: -1, Phase: knowledgeBuildPhaseRetrying, Message: "等待重试",
	})

	progress := writer.snapshot()
	analyzing := findKnowledgeBuildStage(progress.Stages, "", knowledgeBuildPhaseAnalyzing)
	agent := findKnowledgeBuildStage(progress.Stages, knowledgeBuildPhaseAnalyzing, knowledgeBuildStageAgent)
	if progress.Phase != knowledgeBuildPhaseRetrying || analyzing == nil || analyzing.Status != knowledgeBuildStageFailed {
		t.Fatalf("progress=%#v analyzing=%#v", progress, analyzing)
	}
	if agent == nil || agent.Status != knowledgeBuildStageFailed {
		t.Fatalf("agent=%#v", agent)
	}
}

func TestKnowledgeBuildProgressUpsertsAndBoundsAgentActivities(t *testing.T) {
	writer := newKnowledgeBuildTaskProgressWriter(nil, time.Now().UTC(), 1, 3)
	writer.reportAgentActivity(DocumentAgentActivity{
		ID: "call-1", Kind: "tool", Status: knowledgeBuildStageRunning,
		Title: "阅读正文分卷", Detail: "/document/parts/part-001.md", Round: 2,
	})
	writer.reportAgentActivity(DocumentAgentActivity{
		ID: "call-1", Status: knowledgeBuildStageCompleted,
	})
	progress := writer.snapshot()
	if len(progress.AgentActivities) != 1 {
		t.Fatalf("activities=%#v", progress.AgentActivities)
	}
	activity := progress.AgentActivities[0]
	if activity.Status != knowledgeBuildStageCompleted || activity.Title != "阅读正文分卷" ||
		activity.Detail != "/document/parts/part-001.md" || activity.CompletedAt == nil {
		t.Fatalf("activity=%#v", activity)
	}

	for index := 0; index < knowledgeBuildAgentActivityLimit+5; index++ {
		writer.reportAgentActivity(DocumentAgentActivity{
			ID: fmt.Sprintf("bounded-%d", index), Status: knowledgeBuildStageCompleted,
			Title: fmt.Sprintf("动作 %d", index),
		})
	}
	progress = writer.snapshot()
	if len(progress.AgentActivities) != knowledgeBuildAgentActivityLimit {
		t.Fatalf("activities=%d", len(progress.AgentActivities))
	}
	if progress.AgentActivities[0].ID != "bounded-5" {
		t.Fatalf("首条保留活动=%q", progress.AgentActivities[0].ID)
	}
}

func TestKnowledgeBuildProgressKeepsBoundedEvents(t *testing.T) {
	writer := newKnowledgeBuildTaskProgressWriter(nil, time.Now().UTC(), 1, 3)
	for index := 0; index < knowledgeBuildProgressEventLimit+7; index++ {
		writer.reportEvent(knowledgeBuildPhaseAnalyzing, fmt.Sprintf("事件 %d", index))
	}
	progress := writer.snapshot()
	if len(progress.Events) != knowledgeBuildProgressEventLimit {
		t.Fatalf("events=%d", len(progress.Events))
	}
	if progress.Events[0].Message != "事件 7" {
		t.Fatalf("首条保留事件=%q", progress.Events[0].Message)
	}
}

func TestNormalizeLegacyKnowledgeBuildProgressCreatesStages(t *testing.T) {
	now := time.Now().UTC()
	progress := normalizeKnowledgeBuildProgress(knowledgeBuildProgress{
		Percent: 48, Phase: knowledgeBuildPhasePages, Message: "正在生成 Wiki 页面", UpdatedAt: now,
	})
	pages := findKnowledgeBuildStage(progress.Stages, "", knowledgeBuildPhasePages)
	analyzing := findKnowledgeBuildStage(progress.Stages, "", knowledgeBuildPhaseAnalyzing)
	if pages == nil || pages.Status != knowledgeBuildStageRunning {
		t.Fatalf("pages=%#v", pages)
	}
	if analyzing == nil || analyzing.Status != knowledgeBuildStageCompleted {
		t.Fatalf("analyzing=%#v", analyzing)
	}
	if progress.Attempt != 1 || progress.MaxAttempts != 1 || progress.HeartbeatAt.IsZero() {
		t.Fatalf("legacy progress=%#v", progress)
	}
}
