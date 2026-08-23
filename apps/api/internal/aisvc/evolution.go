// evolution.go 对照 review/evolution.ts：月报专属的认知演化时间线。
// 挑一个当期最活跃的主题，回看用户全部时间线上对该主题的笔记，
// 由模型归纳「理解是如何演化的」。素材不足或模型输出无效时静默降级为 nil。
package aisvc

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/db"
)

const (
	evolutionMinArticles = 3
	evolutionMinMonths   = 2
	evolutionMaxArticles = 24
	evolutionSummaryMax  = 200
	evolutionMaxEntries  = 8
)

type evolutionTopic struct {
	kind string // tag | kb
	tag  string
	kbID int64
	name string
}

// beijingTime 包装 time.Time，提供北京月份格式化。
type beijingTime struct{ t time.Time }

func (b beijingTime) BeijingMonth() string {
	return formatBeijingMonth(b.t)
}

type evolutionMaterial struct {
	title     string
	summary   *string
	createdAt beijingTime
}

// selectEvolutionTopic 选题：优先取本期出现 >=2 次的高频标签，否则取最活跃（>=2 篇）的知识库。
func selectEvolutionTopic(stats *reviewStats) *evolutionTopic {
	for _, tag := range stats.TopTags {
		if tag.Count >= 2 {
			return &evolutionTopic{kind: "tag", tag: tag.Tag}
		}
	}
	for _, kb := range stats.KnowledgeBases {
		if kb.ArticleCount >= 2 {
			id := atoi(kb.ID)
			if id > 0 {
				return &evolutionTopic{kind: "kb", kbID: int64(id), name: kb.Name}
			}
		}
	}
	return nil
}

func evolutionTopicLabel(topic *evolutionTopic) string {
	if topic.kind == "tag" {
		return topic.tag
	}
	return topic.name
}

// hasEnoughEvolutionSpan 素材门槛：至少 3 篇笔记、跨至少 2 个自然月（北京时间）。
func hasEnoughEvolutionSpan(articles []evolutionMaterial) bool {
	if len(articles) < evolutionMinArticles {
		return false
	}
	months := map[string]bool{}
	for _, article := range articles {
		months[article.createdAt.BeijingMonth()] = true
	}
	return len(months) >= evolutionMinMonths
}

func gatherEvolutionMaterial(ctx context.Context, userID int64, topic *evolutionTopic) ([]evolutionMaterial, error) {
	pool := db.Pool()

	if topic.kind == "kb" {
		rows, err := pool.Query(ctx, `
			SELECT title, ai_summary, created_at FROM petrichor_kb_article
			WHERE user_id = $1 AND knowledge_base_id = $2
			ORDER BY created_at ASC
			LIMIT $3`, userID, topic.kbID, evolutionMaxArticles)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []evolutionMaterial{}
		for rows.Next() {
			var m evolutionMaterial
			var t time.Time
			if err := rows.Scan(&m.title, &m.summary, &t); err != nil {
				return nil, err
			}
			m.createdAt = beijingTime{t: t}
			out = append(out, m)
		}
		return out, rows.Err()
	}

	idRows, err := pool.Query(ctx,
		`SELECT article_id FROM petrichor_kb_article_tag WHERE tag = $1`, topic.tag)
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	for idRows.Next() {
		var id int64
		if err := idRows.Scan(&id); err != nil {
			idRows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	idRows.Close()
	if idRows.Err() != nil {
		return nil, idRows.Err()
	}
	if len(ids) == 0 {
		return []evolutionMaterial{}, nil
	}

	rows, err := pool.Query(ctx, `
		SELECT title, ai_summary, created_at FROM petrichor_kb_article
		WHERE user_id = $1 AND id = ANY($2)
		ORDER BY created_at ASC
		LIMIT $3`, userID, ids, evolutionMaxArticles)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []evolutionMaterial{}
	for rows.Next() {
		var m evolutionMaterial
		var t time.Time
		if err := rows.Scan(&m.title, &m.summary, &t); err != nil {
			return nil, err
		}
		m.createdAt = beijingTime{t: t}
		out = append(out, m)
	}
	return out, rows.Err()
}

func buildEvolutionSystemPrompt() string {
	return strings.Join([]string{
		"你是一名知识回顾助手，任务是根据用户围绕同一主题、按时间排列的笔记清单，归纳用户对该主题的认知是如何演化的。",
		"硬性规则：",
		"- 只输出一个 JSON 对象，不要输出任何其他文字或代码块标记。",
		`- 格式：{"topic":"主题名","synthesis":"...","entries":[{"period":"YYYY-MM","title":"阶段小标题","note":"..."}]}。`,
		"- entries 按时间升序，3 到 8 条；把相邻且观点相近的笔记合并成一个阶段，不要逐篇罗列。",
		"- 每条 note 用 1-2 句中文概括该阶段的核心认知或相对上一阶段的转变（承接、深化、修正、推翻都要点明），不超过 80 字。",
		"- synthesis 用 2-3 句中文总述整条演化轨迹（从什么认识出发，经历了什么转折，现在停在哪里）。",
		"- 只基于给出的标题与摘要归纳，不要虚构笔记中不存在的观点。",
		"- 素材看不出任何演化脉络时，输出 {\"topic\":\"\",\"synthesis\":\"\",\"entries\":[]}。",
	}, "\n")
}

func buildEvolutionUserMessage(topicLabel string, articles []evolutionMaterial) string {
	lines := []string{
		"主题：" + topicLabel,
		"以下是用户围绕该主题的 " + itoa(len(articles)) + " 篇笔记，按写作时间升序：",
		"",
	}
	for _, article := range articles {
		summary := "（无摘要）"
		if article.summary != nil && strings.TrimSpace(*article.summary) != "" {
			summary = truncatePromptText(*article.summary, evolutionSummaryMax)
		}
		lines = append(lines, "- ["+article.createdAt.BeijingMonth()+"] "+article.title+"："+summary)
	}
	lines = append(lines, "", "请归纳这条认知演化时间线。")
	return strings.Join(lines, "\n")
}

var evolutionPeriodPattern = regexp.MustCompile(`^\d{4}-\d{2}$`)

// parseEvolutionResult 解析模型输出；任何形状问题都返回 nil。
func parseEvolutionResult(raw string) *reviewEvolution {
	jsonText := extractJSONObjectText(raw)
	var parsed map[string]any
	if err := json.Unmarshal([]byte(jsonText), &parsed); err != nil || parsed == nil {
		return nil
	}

	topic := trimmedStringField(parsed["topic"])
	synthesis := trimmedStringField(parsed["synthesis"])
	rawEntries, _ := parsed["entries"].([]any)

	entries := []evolutionEntry{}
	for _, item := range rawEntries {
		entryMap, ok := item.(map[string]any)
		if !ok {
			continue
		}
		period := trimmedStringField(entryMap["period"])
		title := trimmedStringField(entryMap["title"])
		note := trimmedStringField(entryMap["note"])
		if !evolutionPeriodPattern.MatchString(period) || note == "" {
			continue
		}
		displayTitle := title
		if displayTitle == "" {
			displayTitle = period
		}
		entries = append(entries, evolutionEntry{
			Period: period,
			Title:  displayTitle,
			Note:   truncatePromptText(note, 200),
		})
	}
	if len(entries) > evolutionMaxEntries {
		entries = entries[:evolutionMaxEntries]
	}
	if topic == "" || synthesis == "" || len(entries) < 2 {
		return nil
	}
	return &reviewEvolution{
		Topic:     topic,
		Synthesis: truncatePromptText(synthesis, 600),
		Entries:   entries,
	}
}

func buildEvolutionForReview(ctx context.Context, userID int64, stats *reviewStats) (*reviewEvolution, error) {
	topic := selectEvolutionTopic(stats)
	if topic == nil {
		return nil, nil
	}
	articles, err := gatherEvolutionMaterial(ctx, userID, topic)
	if err != nil {
		return nil, err
	}
	if !hasEnoughEvolutionSpan(articles) {
		return nil, nil
	}

	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeChat, nil)
	if err != nil {
		return nil, err
	}
	result, err := aicore.Chat(ctx, resolved.Runtime, resolved.ModelRef, []aicore.ChatMessage{
		{Role: "system", Content: buildEvolutionSystemPrompt()},
		{Role: "user", Content: buildEvolutionUserMessage(evolutionTopicLabel(topic), articles)},
	}, resolved.Options)
	if err != nil {
		return nil, err
	}
	return parseEvolutionResult(result.Answer), nil
}

func extractJSONObjectText(raw string) string {
	stripped := strings.TrimSpace(regexp.MustCompile("(?i)^```(?:json)?\\s*").ReplaceAllString(
		regexp.MustCompile("(?i)\\s*```$").ReplaceAllString(strings.TrimSpace(raw), ""), ""))
	start := strings.Index(stripped, "{")
	end := strings.LastIndex(stripped, "}")
	if start >= 0 && end > start {
		return stripped[start : end+1]
	}
	return stripped
}

func trimmedStringField(v any) string {
	s, _ := v.(string)
	return strings.TrimSpace(s)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
