package kb

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const (
	articleSummaryMaxModelInputChars = 12000
	articleSummaryMaxChars           = 420
)

var (
	summaryFenceOpenRE  = regexp.MustCompile(`(?i)^` + "```" + `(?:markdown|md|text)?\s*`)
	summaryFenceCloseRE = regexp.MustCompile(`(?i)\s*` + "```" + `$`)
	summaryHeadingRE    = regexp.MustCompile(`^#{1,6}\s*摘要\s*`)
	summaryPrefixRE     = regexp.MustCompile(`(?i)^(文章)?(AI\s*)?摘要[:：]\s*`)
)

type SummaryGenerateInput struct {
	ArticleID    int64
	ForceRebuild bool
}

type SummaryGenerateResult struct {
	ArticleID   string
	Summary     string
	FromCache   bool
	GeneratedAt *string
}

func ValidateSummaryGenerateInput(articleIDRaw string, forceRebuild bool) (SummaryGenerateInput, error) {
	articleIDRaw = strings.TrimSpace(articleIDRaw)
	if articleIDRaw == "" {
		return SummaryGenerateInput{}, response.BadRequest("文章ID不能为空")
	}
	id, err := parsePositiveID(articleIDRaw, "articleId")
	if err != nil {
		return SummaryGenerateInput{}, response.BadRequest("文章ID非法")
	}
	return SummaryGenerateInput{ArticleID: id, ForceRebuild: forceRebuild}, nil
}

func BuildArticleSummarySystemPrompt() string {
	return strings.Join([]string{
		"你是一个严谨的文章摘要助手。",
		"请根据用户提供的文章标题与 Markdown 正文，生成一段中文摘要。",
		"规则：",
		"- 只输出摘要正文，不要输出标题、解释、项目符号、Markdown 或代码块。",
		"- 摘要控制在 80 到 180 个汉字左右，最多不超过 420 个字符。",
		"- 优先概括文章核心观点、关键结论和阅读价值。",
		"- 不要虚构文章中不存在的事实。",
		"- 如果正文信息很少，也要给出自然的一句话概括。",
	}, "\n")
}

func BuildArticleSummaryUserMessage(title, contentMd string) string {
	content := contentMd
	if len([]rune(content)) > articleSummaryMaxModelInputChars {
		content = string([]rune(content)[:articleSummaryMaxModelInputChars]) + "\n\n[内容已截断]"
	}
	return strings.Join([]string{
		"文章标题：" + title,
		"",
		"文章 Markdown 正文：",
		content,
	}, "\n")
}

func NormalizeArticleSummaryModelOutput(raw string) (string, error) {
	normalized := strings.TrimSpace(raw)
	normalized = summaryFenceOpenRE.ReplaceAllString(normalized, "")
	normalized = summaryFenceCloseRE.ReplaceAllString(normalized, "")
	normalized = summaryHeadingRE.ReplaceAllString(normalized, "")
	normalized = summaryPrefixRE.ReplaceAllString(normalized, "")
	normalized = collapseWhitespace(normalized)

	if normalized == "" {
		return "", response.BadRequest("模型未返回有效摘要")
	}
	runes := []rune(normalized)
	if len(runes) > articleSummaryMaxChars {
		trimmed := strings.TrimRight(string(runes[:articleSummaryMaxChars]), " \t")
		return trimmed + "...", nil
	}
	return normalized, nil
}

func IsArticleAiSummaryCacheHit(currentHash, storedHash, summary string) bool {
	return strings.TrimSpace(summary) != "" &&
		strings.TrimSpace(storedHash) != "" &&
		storedHash == currentHash
}

func collapseWhitespace(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	prevSpace := false
	for _, r := range s {
		if unicode.IsSpace(r) {
			if !prevSpace {
				b.WriteRune(' ')
				prevSpace = true
			}
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return strings.TrimSpace(b.String())
}

func formatTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	v := t.UTC().Format(time.RFC3339Nano)
	return &v
}

func (s *Service) GenerateArticleSummary(ctx context.Context, userID int64, input SummaryGenerateInput) (*SummaryGenerateResult, error) {
	article, err := s.client.KBArticle.Query().
		Where(kbarticle.IDEQ(input.ArticleID), kbarticle.UserIDEQ(userID)).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("文章不存在")
		}
		return nil, err
	}

	contentHash := BuildArticleAiSummaryContentHash(article.ContentMd)
	articleID := fmt.Sprintf("%d", article.ID)

	if !input.ForceRebuild {
		storedHash := ""
		if article.AiSummaryContentHash != nil {
			storedHash = *article.AiSummaryContentHash
		}
		summary := ""
		if article.AiSummary != nil {
			summary = *article.AiSummary
		}
		if IsArticleAiSummaryCacheHit(contentHash, storedHash, summary) {
			return &SummaryGenerateResult{
				ArticleID:   articleID,
				Summary:     summary,
				FromCache:   true,
				GeneratedAt: formatTimePtr(article.AiSummaryGeneratedAt),
			}, nil
		}
	}

	modelCfg, err := ai.ResolveChatConfig(ctx, s.client, userID)
	if err != nil {
		return nil, err
	}
	gen := ai.NewGeneration(s.cfg)
	chatResult, err := gen.Chat(ctx, modelCfg, []ai.ChatMessage{
		{Role: "system", Content: BuildArticleSummarySystemPrompt()},
		{Role: "user", Content: BuildArticleSummaryUserMessage(article.Title, article.ContentMd)},
	})
	if err != nil {
		return nil, err
	}

	summary, err := NormalizeArticleSummaryModelOutput(chatResult.Content)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	updated, err := article.Update().
		SetAiSummary(summary).
		SetAiSummaryContentHash(contentHash).
		SetAiSummaryGeneratedAt(now).
		Save(ctx)
	if err != nil {
		return nil, err
	}

	return &SummaryGenerateResult{
		ArticleID:   articleID,
		Summary:     summary,
		FromCache:   false,
		GeneratedAt: formatTimePtr(updated.AiSummaryGeneratedAt),
	}, nil
}
