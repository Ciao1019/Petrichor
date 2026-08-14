package kb

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseGeneratedQuestionsStripsNumbering(t *testing.T) {
	raw := strings.Join([]string{
		"1. 如何配置知识库的分块策略？",
		"2) 父子分块解决的是什么问题？",
		"- 向量化失败后要怎么补齐？",
		"",
		"好",
	}, "\n")
	questions := ParseGeneratedQuestions(raw, 10)
	want := []string{
		"如何配置知识库的分块策略？",
		"父子分块解决的是什么问题？",
		"向量化失败后要怎么补齐？",
	}
	if len(questions) != len(want) {
		t.Fatalf("应解析出 %d 条问题，实际 %#v", len(want), questions)
	}
	for index, question := range want {
		if questions[index] != question {
			t.Fatalf("第 %d 条问题为 %q，期望 %q", index, questions[index], question)
		}
	}
}

func TestParseGeneratedQuestionsRespectsLimit(t *testing.T) {
	raw := "第一个问题是什么？\n第二个问题是什么？\n第三个问题是什么？"
	if got := ParseGeneratedQuestions(raw, 2); len(got) != 2 {
		t.Fatalf("应截断到 2 条，实际 %#v", got)
	}
	if got := ParseGeneratedQuestions(raw, 0); got != nil {
		t.Fatalf("限制为 0 时不应返回问题，实际 %#v", got)
	}
}

func TestParseGeneratedQuestionsDedupes(t *testing.T) {
	raw := "重复的问题是什么？\n1. 重复的问题是什么？\n另一个问题是什么？"
	got := ParseGeneratedQuestions(raw, 10)
	if len(got) != 2 {
		t.Fatalf("重复问题应去重，实际 %#v", got)
	}
}

func TestBuildQuestionGenerationPromptIncludesContextAndInstructions(t *testing.T) {
	prompt := BuildQuestionGenerationPrompt("年度报告", "正文内容", "上文", "下文", 4, "面向客服")
	for _, fragment := range []string{
		"年度报告", "正文内容", "<preceding_content>", "上文", "<following_content>", "下文",
		"生成 4 个问题", "面向客服",
	} {
		if !strings.Contains(prompt, fragment) {
			t.Fatalf("提示词缺少片段 %q", fragment)
		}
	}
}

// 没有前后文时不应输出空的 surrounding_context 包裹，
// 那只会浪费 token 并让模型以为上下文被截断了。
func TestBuildQuestionGenerationPromptOmitsEmptyContext(t *testing.T) {
	prompt := BuildQuestionGenerationPrompt("标题", "正文", "", "", 3, "")
	if strings.Contains(prompt, "<surrounding_context>") {
		t.Fatal("没有前后文时不应输出 surrounding_context")
	}
	if strings.Contains(prompt, "额外要求") {
		t.Fatal("没有自定义要求时不应输出额外要求段落")
	}
}

func TestHeadAndTailRunes(t *testing.T) {
	if got := headRunes("知识库文档", 2); got != "知识" {
		t.Fatalf("headRunes 结果为 %q", got)
	}
	if got := tailRunes("知识库文档", 2); got != "文档" {
		t.Fatalf("tailRunes 结果为 %q", got)
	}
	if got := headRunes("短", 10); got != "短" {
		t.Fatalf("不足长度时应原样返回，实际 %q", got)
	}
}

func TestRunConcurrentChunkJobsUsesRequestedConcurrency(t *testing.T) {
	const (
		total       = 25
		concurrency = 20
	)
	started := make(chan struct{}, total)
	release := make(chan struct{})
	done := make(chan struct{})
	var releaseOnce sync.Once
	var completed atomic.Int64
	releaseAll := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseAll()

	go func() {
		runConcurrentChunkJobs(context.Background(), total, concurrency, func(_ int) {
			started <- struct{}{}
			<-release
			completed.Add(1)
		})
		close(done)
	}()

	for index := 0; index < concurrency; index++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatalf("只有 %d 个任务进入并发执行，期望 %d", index, concurrency)
		}
	}
	select {
	case <-started:
		t.Fatalf("释放 worker 前不应启动第 %d 个任务", concurrency+1)
	default:
	}

	releaseAll()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("并发任务未按时结束")
	}
	if completed.Load() != total {
		t.Fatalf("应处理 %d 个分片，实际 %d", total, completed.Load())
	}
}
