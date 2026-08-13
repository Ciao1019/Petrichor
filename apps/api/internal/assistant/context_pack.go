package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

const (
	contextRecentMessageMin = 6
	contextRecentMessageMax = 20
	maxContextTokens        = 100_000
)

type contextWindowPolicy struct {
	RecentCount int
	Reason      string
}

type contextPack struct {
	SummaryMd              string
	RecentMessages         []chatUIMessage
	CompressedMessageCount int
	Status                 string
	WindowPolicy           contextWindowPolicy
	RecalledSnippets       []recalledSnippet
}

func estimateMessageTokens(messages []chatUIMessage) int {
	raw, _ := json.Marshal(messages)
	return (len(raw) + 1) / 2
}

func resolveRecentWindowPolicy(messages []chatUIMessage, tokenBudget int) contextWindowPolicy {
	total := len(messages)
	if total <= contextRecentMessageMin {
		return contextWindowPolicy{RecentCount: total, Reason: "fixed"}
	}
	recentBudget := tokenBudget * 35 / 100
	if recentBudget < 1 {
		recentBudget = 1
	}
	hardMax := contextRecentMessageMax
	if total < hardMax {
		hardMax = total
	}
	count := contextRecentMessageMin
	for n := contextRecentMessageMin + 1; n <= hardMax; n++ {
		slice := messages[len(messages)-n:]
		if estimateMessageTokens(slice) <= recentBudget {
			count = n
		} else {
			break
		}
	}
	if count == contextRecentMessageMin {
		return contextWindowPolicy{RecentCount: count, Reason: "fixed"}
	}
	if count == contextRecentMessageMax {
		return contextWindowPolicy{RecentCount: count, Reason: "turn_budget"}
	}
	return contextWindowPolicy{RecentCount: count, Reason: "token_budget"}
}

func shouldRefreshContextSummary(messages []chatUIMessage, persistedCount, recentCount int) bool {
	if len(messages) <= recentCount {
		return false
	}
	if estimateMessageTokens(messages) > maxContextTokens*55/100 {
		return true
	}
	return persistedCount > 20
}

func buildContextPack(ctx context.Context, client *ent.Client, deps recallDeps, input struct {
	UserID            int64
	ThreadID          int64
	Messages          []chatUIMessage
	TokenBudget       int
	PersistedCount    int
	SkipRefresh       bool
	UserText          string
	ExcludeMessageIDs []int64
}) contextPack {
	policy := resolveRecentWindowPolicy(input.Messages, input.TokenBudget)
	recentCount := policy.RecentCount
	if recentCount <= 0 {
		recentCount = len(input.Messages)
	}
	recentStart := 0
	if len(input.Messages) > recentCount {
		recentStart = len(input.Messages) - recentCount
	}
	recent := append([]chatUIMessage(nil), input.Messages[recentStart:]...)

	pack := contextPack{
		RecentMessages: recent,
		Status:         "skipped",
		WindowPolicy:   policy,
	}

	if input.SkipRefresh || !shouldRefreshContextSummary(input.Messages, input.PersistedCount, recentCount) {
		if input.ThreadID > 0 && strings.TrimSpace(input.UserText) != "" {
			pack.RecalledSnippets = recallRelevantHistory(ctx, client, deps, recallInput{
				UserID:            input.UserID,
				ThreadID:          input.ThreadID,
				Query:             input.UserText,
				ExcludeMessageIDs: input.ExcludeMessageIDs,
			})
		}
		return pack
	}

	foldable := input.Messages[:recentStart]
	pack.CompressedMessageCount = len(foldable)
	pack.Status = "done"
	if input.ThreadID > 0 {
		summary := summarizeFoldedMessages(foldable)
		pack.SummaryMd = summary
	}
	if input.ThreadID > 0 && strings.TrimSpace(input.UserText) != "" {
		pack.RecalledSnippets = recallRelevantHistory(ctx, client, deps, recallInput{
			UserID:            input.UserID,
			ThreadID:          input.ThreadID,
			Query:             input.UserText,
			ExcludeMessageIDs: input.ExcludeMessageIDs,
		})
	}
	return pack
}

func summarizeFoldedMessages(messages []chatUIMessage) string {
	if len(messages) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("较早对话摘要：\n")
	for _, m := range messages {
		text := extractMessagePlainText(m)
		if text == "" {
			continue
		}
		if runes := []rune(text); len(runes) > 200 {
			text = string(runes[:200]) + "…"
		}
		b.WriteString("- ")
		b.WriteString(m.Role)
		b.WriteString(": ")
		b.WriteString(text)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

func buildInstructionsWithContext(basePrompt, summaryMd string, snippets []recalledSnippet) string {
	parts := []string{basePrompt}
	if strings.TrimSpace(summaryMd) != "" {
		parts = append(parts, "", "以下是本对话较早内容的摘要（已折叠细节，仅供连贯理解；最近几轮原文仍在消息中）：", summaryMd)
	}
	if len(snippets) > 0 {
		parts = append(parts, "", "以下是与当前问题相关的较早对话片段（向量/关键词召回，供参考，非完整历史）：")
		for i, s := range snippets {
			parts = append(parts, formatRecallLine(i+1, s))
		}
	}
	return strings.Join(parts, "\n")
}

func formatRecallLine(index int, s recalledSnippet) string {
	return fmt.Sprintf("%d. (相关度 %.2f) %s", index, s.Score, s.Excerpt)
}

func extractMessagePlainText(m chatUIMessage) string {
	for _, p := range m.Parts {
		if p.Type == "text" && strings.TrimSpace(p.Text) != "" {
			return strings.TrimSpace(p.Text)
		}
	}
	if s, ok := m.Content.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}
