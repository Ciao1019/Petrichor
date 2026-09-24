package kb

import (
	"context"
	"os"
	"slices"
	"testing"
	"time"

	"petrichor/api/internal/config"
	"petrichor/api/internal/typesafe"
)

// 显式启用才会产生真实 API 用量；只发送合成数据，不连接数据库。
func TestInboxRecommendationJevLive(t *testing.T) {
	if os.Getenv("PETRICHOR_INBOX_JEV_LIVE_TEST") != "1" {
		t.Skip("设置 PETRICHOR_INBOX_JEV_LIVE_TEST=1 才调用真实 Jev 接口")
	}
	c, err := config.Load()
	if err != nil {
		t.Fatal("本地配置加载失败，请检查 config.toml")
	}
	cfg := c.TypeSafe
	if !cfg.Enabled || cfg.APIKey == "" {
		t.Fatal("请先在本地 config.toml 配置并启用 TypeSafe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.TimeoutSeconds)*time.Second)
	defer cancel()
	start, calls := time.Now(), 0
	evaluate := func(ctx context.Context, state any, questions map[string]typesafe.Question) (*typesafe.Result, error) {
		calls++
		result, err := typesafe.Evaluate(ctx, cfg.BaseURL, cfg.APIKey, cfg.Model, state, questions)
		if err == nil {
			for id, answer := range result.Answers {
				if answer.Noul != nil {
					t.Logf("合成标签 %s 的匹配分数：%.3f", id, *answer.Noul)
				}
			}
		}
		return result, err
	}
	note := &inboxNote{ContentMd: "今天学习 React 性能优化：使用 React.memo 跳过无变化组件的渲染，使用 useMemo 缓存昂贵计算，并用 Profiler 找到重复渲染的原因。", Tags: []string{"学习笔记"}}
	bases := []inboxBaseCandidate{
		{ID: "1", Name: "前端工程", Description: "React、TypeScript、浏览器与 Web 性能优化"},
		{ID: "2", Name: "厨房食谱", Description: "烘焙、家常菜与食材搭配"},
		{ID: "3", Name: "旅行计划", Description: "目的地攻略、交通与住宿"},
	}
	out, state, err := recommendInboxBaseAndTags(ctx, evaluate, cfg, note, bases, []string{"React", "性能优化", "烘焙"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if out.Destination == nil || out.Destination.KnowledgeBaseID != "1" {
		t.Fatalf("合成样例未匹配预期知识库：status=%s confidence=%.3f", out.Status, out.Confidence)
	}
	folders := []inboxFolderCandidate{{ID: "10", Path: "React / 性能优化"}, {ID: "11", Path: "CSS / 布局"}}
	if err := recommendInboxFolder(ctx, evaluate, cfg, state, folders, false, out); err != nil {
		t.Fatal(err)
	}
	if out.Destination.ParentID == nil || *out.Destination.ParentID != "10" {
		t.Fatal("合成样例未匹配预期文件夹")
	}
	if !slices.Contains(out.Tags, "React") || slices.Contains(out.Tags, "烘焙") {
		t.Fatalf("合成样例标签判断不符合预期：%v", out.Tags)
	}
	t.Logf("真实中文样例通过：model=%s calls=%d elapsed=%s confidence=%.3f tags=%v input_tokens=%d output_tokens=%d", out.Model, calls, time.Since(start).Round(time.Millisecond), out.Confidence, out.Tags, out.Usage.InputTokens, out.Usage.OutputTokens)
}
