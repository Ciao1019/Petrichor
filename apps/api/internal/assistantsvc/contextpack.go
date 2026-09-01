package assistantsvc

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	aicore "petrichor/api/internal/aicore"
)

const (
	assistantRecentMessageMin   = 6
	assistantRecentMessageMax   = 20
	assistantRecentTokenRatio   = 0.35
	assistantSummaryTokenRatio  = 0.55
	assistantSummaryTurnTrigger = 20
	assistantSummaryTimeout     = 8 * time.Second
)

type assistantContextPack struct {
	Messages   []map[string]any
	Background string
}

// buildAssistantContextPack 对齐 TS 的动态最近窗口与持久摘要。摘要刷新失败时严格
// fail-open：有旧摘要就用旧摘要 + 最近原文，没有旧摘要就保留原消息交给 Runtime 裁剪。
// assistantCompressNotify 折叠历史前后各调一次（"running" / "done"）。
// 只在真的要重算摘要时才触发——那是一次额外的 LLM 调用，用户会等；
// 命中已有摘要或无需折叠时不发，免得闪一下没有意义的提示。
type assistantCompressNotify func(status string)

func buildAssistantContextPack(
	ctx context.Context,
	userID, threadID int64,
	systemRole string,
	messages []map[string]any,
	tokenBudget int64,
	resolved *aicore.ResolvedModel,
	onCompress assistantCompressNotify,
) assistantContextPack {
	recentCount := resolveAssistantRecentCount(messages, tokenBudget)
	cutoff := len(messages) - recentCount
	if cutoff < 0 {
		cutoff = 0
	}
	foldable := messages[:cutoff]
	recent := messages[cutoff:]

	existingSummary, persistedCount := loadAssistantSummaryState(ctx, userID, threadID)
	recalled := recallAssistantHistoryBestEffort(ctx, userID, threadID, messages, recentCount, persistedCount)
	operatorMemory := loadOperatorMemoryBackground(ctx, userID, threadID, systemRole)
	needsRefresh := len(foldable) > 0 && (estimateAssistantMessageTokens(messages) > int64(float64(tokenBudget)*assistantSummaryTokenRatio) ||
		persistedCount > assistantSummaryTurnTrigger)

	summary := existingSummary
	if needsRefresh && resolved != nil {
		if onCompress != nil {
			onCompress("running")
		}
		if refreshed, err := refreshAssistantSummary(ctx, userID, threadID, recentCount, existingSummary, foldable, resolved); err == nil {
			summary = refreshed
		}
		if onCompress != nil {
			onCompress("done")
		}
	}
	background := buildAssistantBackground(summary, recalled, operatorMemory)
	if strings.TrimSpace(background) == "" {
		return assistantContextPack{Messages: messages}
	}
	modelMessages := messages
	if strings.TrimSpace(summary) != "" {
		modelMessages = recent
	}
	return assistantContextPack{
		Messages:   modelMessages,
		Background: background,
	}
}

func resolveAssistantRecentCount(messages []map[string]any, tokenBudget int64) int {
	total := len(messages)
	if total <= assistantRecentMessageMin {
		return total
	}
	if tokenBudget <= 0 {
		tokenBudget = 100_000
	}
	recentBudget := int64(float64(tokenBudget) * assistantRecentTokenRatio)
	hardMax := assistantRecentMessageMax
	if total < hardMax {
		hardMax = total
	}
	count := assistantRecentMessageMin
	for candidate := assistantRecentMessageMin + 1; candidate <= hardMax; candidate++ {
		if estimateAssistantMessageTokens(messages[total-candidate:]) > recentBudget {
			break
		}
		count = candidate
	}
	return count
}

func estimateAssistantMessageTokens(messages []map[string]any) int64 {
	raw, _ := json.Marshal(messages)
	return int64((len([]rune(string(raw))) + 1) / 2)
}

func loadAssistantSummaryState(ctx context.Context, userID, threadID int64) (string, int) {
	var summary *string
	if err := dbPool().QueryRow(ctx, `
		SELECT context_summary_md FROM petrichor_assistant_thread
		WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, threadID, userID).Scan(&summary); err != nil {
		return "", 0
	}
	var count int
	if err := dbPool().QueryRow(ctx, `
		SELECT count(*)::int FROM petrichor_assistant_message WHERE thread_id=$1`, threadID).Scan(&count); err != nil {
		return strings.TrimSpace(derefOrEmpty(summary)), 0
	}
	return strings.TrimSpace(derefOrEmpty(summary)), count
}

func refreshAssistantSummary(
	ctx context.Context,
	userID, threadID int64,
	recentCount int,
	previous string,
	foldable []map[string]any,
	resolved *aicore.ResolvedModel,
) (string, error) {
	transcript := buildAssistantFoldableTranscript(foldable)
	if transcript == "" {
		return previous, nil
	}
	summaryCtx, cancel := context.WithTimeout(ctx, assistantSummaryTimeout)
	defer cancel()
	messages := []aicore.ChatMessage{{
		Role: "system",
		Content: "你是对话上下文压缩器。把较早的多轮对话压成简洁中文摘要，保留：用户目标、已确认事实、未决任务、关键实体 ID/路径（如 articleId、knowledgeBaseId、documentId）。" +
			"工具结果若已折叠，优先保留其中的 id 与错误码。不要编造；不要输出 API Key、Cookie、密码；不要使用 Markdown 标题堆砌。只输出摘要正文。",
	}}
	if strings.TrimSpace(previous) != "" {
		messages = append(messages, aicore.ChatMessage{Role: "user", Content: "已有摘要：\n" + strings.TrimSpace(previous)})
	}
	messages = append(messages, aicore.ChatMessage{Role: "user", Content: "请将以下较早对话并入摘要：\n\n" + transcript})
	result, err := aicore.Chat(summaryCtx, resolved.Runtime, resolved.ModelRef, messages, resolved.Options)
	if err != nil {
		return "", err
	}
	summary := strings.TrimSpace(result.Answer)
	if summary == "" {
		return "", context.Canceled
	}
	summary = truncateStoreText(summary, 8_000)

	var watermark any
	var messageID int64
	if err := dbPool().QueryRow(ctx, `
		SELECT id FROM petrichor_assistant_message
		WHERE thread_id=$1 ORDER BY created_at DESC, id DESC OFFSET $2 LIMIT 1`,
		threadID, recentCount).Scan(&messageID); err == nil {
		watermark = messageID
	}
	_, err = dbPool().Exec(ctx, `
		UPDATE petrichor_assistant_thread SET
			context_summary_md=$1, context_summary_until_message_id=$2,
			context_summary_updated_at=$3, updated_at=$3
		WHERE id=$4 AND user_id=$5`, summary, watermark, time.Now(), threadID, userID)
	if err != nil {
		return "", err
	}
	return summary, nil
}

func buildAssistantFoldableTranscript(messages []map[string]any) string {
	var builder strings.Builder
	for _, message := range messages {
		role, _ := message["role"].(string)
		content, _ := message["content"].(string)
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteString("\n\n")
		}
		builder.WriteString(role)
		builder.WriteString(": ")
		builder.WriteString(content)
		if len([]rune(builder.String())) >= 24_000 {
			return truncateStoreText(builder.String(), 24_000)
		}
	}
	return builder.String()
}
