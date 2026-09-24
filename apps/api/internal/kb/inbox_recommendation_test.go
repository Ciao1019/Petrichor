package kb

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"petrichor/api/internal/config"
	"petrichor/api/internal/typesafe"
)

func recommendationFixture() (*inboxNote, []inboxBaseCandidate, config.TypeSafeConfig) {
	return &inboxNote{ID: 1, Version: 3, ContentMd: "PostgreSQL 索引调优经验", Tags: []string{"随手记"}},
		[]inboxBaseCandidate{{ID: "7", Name: "数据库", Description: "PostgreSQL"}, {ID: "8", Name: "阅读"}},
		config.TypeSafeConfig{MinConfidence: 0.7, TagThreshold: 0.85}
}

func fixedInboxEvaluator(choice string, confidence float64) inboxEvaluator {
	return func(_ context.Context, _ any, qs map[string]typesafe.Question) (*typesafe.Result, error) {
		answers := map[string]typesafe.Answer{}
		for id, question := range qs {
			if question.Type == "choice" {
				answers[id] = typesafe.Answer{Choice: choice, Confidence: &confidence, Probabilities: map[string]float64{"b0": 0.55, "b1": 0.4, "none": 0.05}}
			} else {
				n := 0.95
				if id == "t1" {
					n = 0.6
				}
				answers[id] = typesafe.Answer{Noul: &n}
			}
		}
		return &typesafe.Result{Model: "jev-1.13.0", Answers: answers, Usage: typesafe.Usage{InputTokens: 100}}, nil
	}
}

func TestInboxRecommendationConfidenceAndExistingTags(t *testing.T) {
	note, bases, cfg := recommendationFixture()
	for _, tc := range []struct {
		choice       string
		confidence   float64
		status       string
		alternatives int
	}{
		{"b0", 0.9, "recommended", 0}, {"b0", 0.4, "uncertain", 2}, {"none", 0.95, "no_match", 0},
	} {
		out, _, err := recommendInboxBaseAndTags(context.Background(), fixedInboxEvaluator(tc.choice, tc.confidence), cfg, note, bases, []string{"随手记", "PostgreSQL", "阅读"}, false)
		if err != nil || out.Status != tc.status || len(out.Alternatives) != tc.alternatives || !slices.Equal(out.Tags, []string{"PostgreSQL"}) {
			t.Fatal(out, err)
		}
		if tc.status == "recommended" && (out.Destination == nil || out.Destination.KnowledgeBaseID != "7" || out.Destination.ParentID != nil) {
			t.Fatal(out)
		}
		if tc.status != "recommended" && out.Destination != nil {
			t.Fatal("不确定时不能自动选择位置")
		}
	}
	// 没有知识库时不能浪费收费请求。
	out, _, err := recommendInboxBaseAndTags(context.Background(), func(context.Context, any, map[string]typesafe.Question) (*typesafe.Result, error) {
		t.Fatal("不应调用")
		return nil, nil
	}, cfg, note, nil, nil, false)
	if err != nil || out.Status != "no_match" {
		t.Fatal(out, err)
	}
}

func TestInboxRecommendationFolderAndBudget(t *testing.T) {
	note, bases, cfg := recommendationFixture()
	note.ContentMd = strings.Repeat("长文", 15000)
	for i := range 100 {
		bases = append(bases, inboxBaseCandidate{ID: fmt.Sprint(i + 20), Name: strings.Repeat("库", 80), Description: strings.Repeat("说明", 100)})
	}
	evaluator := func(ctx context.Context, state any, questions map[string]typesafe.Question) (*typesafe.Result, error) {
		if !typesafe.WithinBudget(state, questions) {
			t.Fatal("超出请求预算")
		}
		if strings.Contains(fmt.Sprint(state), strings.Repeat("长文", 3000)) {
			t.Fatal("未限制长正文")
		}
		return fixedInboxEvaluator("b0", 0.9)(ctx, state, questions)
	}
	out, state, err := recommendInboxBaseAndTags(context.Background(), evaluator, cfg, note, bases, nil, false)
	if err != nil || len(out.Warnings) < 2 {
		t.Fatal(out, err)
	}
	folders := []inboxFolderCandidate{{ID: "12", Path: "数据库 / PostgreSQL"}}
	if err = recommendInboxFolder(context.Background(), fixedInboxEvaluator("f0", 0.95), cfg, state, folders, false, out); err != nil || out.Destination.ParentID == nil || *out.Destination.ParentID != "12" || out.Usage.InputTokens != 200 {
		t.Fatal(out, err)
	}
	out.Destination.ParentID = nil
	if err = recommendInboxFolder(context.Background(), fixedInboxEvaluator("f0", 0.3), cfg, state, folders, false, out); err != nil || out.Destination.ParentID != nil {
		t.Fatal("低置信度应保留根目录", out, err)
	}
	if note.ContentMd != strings.Repeat("长文", 15000) {
		t.Fatal("截断不能修改随笔原文")
	}
}

func TestInboxRecommendationTagLimitAndArchiveValidation(t *testing.T) {
	note, bases, cfg := recommendationFixture()
	for i := range 19 {
		note.Tags = append(note.Tags, fmt.Sprintf("标签%d", i))
	}
	out, _, err := recommendInboxBaseAndTags(context.Background(), fixedInboxEvaluator("b0", .9), cfg, note, bases, []string{"数据库"}, false)
	if err != nil || len(out.Tags) != 0 {
		t.Fatal("不能超出 20 个标签", out, err)
	}
	base := map[string]any{"id": "1", "version": float64(1), "knowledgeBaseId": "7", "title": "归档"}
	for _, raw := range []any{nil, "标签", []any{42}, []any{strings.Repeat("字", 81)}} {
		base["tags"] = raw
		if _, err := parseInboxArchive(base); err == nil {
			t.Fatal("无效归档标签未被拒绝")
		}
	}
	base["tags"] = []any{}
	in, err := parseInboxArchive(base)
	if err != nil || in.Tags == nil || len(*in.Tags) != 0 {
		t.Fatal("空数组应明确清空文章标签", err)
	}
	delete(base, "tags")
	in, err = parseInboxArchive(base)
	if err != nil || in.Tags != nil {
		t.Fatal("省略字段应保留随笔标签", err)
	}
}

func TestInboxRecommendationReceiptCannotCrossUsersOrVersions(t *testing.T) {
	note, bases, cfg := recommendationFixture()
	out, _, _ := recommendInboxBaseAndTags(context.Background(), fixedInboxEvaluator("b0", .9), cfg, note, bases, []string{"数据库"}, false)
	token := signInboxRecommendation(10, note, out)
	if verifyInboxRecommendation(token, 10, note.ID, note.Version) == nil {
		t.Fatal("合法回执未通过")
	}
	for _, ids := range [][3]int64{{11, 1, 3}, {10, 2, 3}, {10, 1, 4}} {
		if verifyInboxRecommendation(token, ids[0], ids[1], ids[2]) != nil {
			t.Fatal("回执没有绑定用户、随笔和版本")
		}
	}
	parts := strings.Split(token, ".")
	if verifyInboxRecommendation(parts[0]+"."+base64.RawURLEncoding.EncodeToString([]byte("tamper")), 10, 1, 3) != nil {
		t.Fatal("篡改回执未被拒绝")
	}
	r := verifyInboxRecommendation(token, 10, 1, 3)
	r.Expires = time.Now().Add(-time.Hour).Unix()
	payload, _ := json.Marshal(r)
	expired := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(inboxRecommendationMAC(payload))
	if verifyInboxRecommendation(expired, 10, 1, 3) != nil {
		t.Fatal("过期回执未被拒绝")
	}
}

func TestInboxRecommendationConcurrency(t *testing.T) {
	if !acquireInboxRecommendation(12345) {
		t.Fatal("首次应允许")
	}
	defer releaseInboxRecommendation(12345)
	if acquireInboxRecommendation(12345) {
		t.Fatal("同一用户不能并发触发收费请求")
	}
	if !acquireInboxRecommendation(12346) {
		t.Fatal("不同用户可以并行")
	}
	releaseInboxRecommendation(12346)
}
