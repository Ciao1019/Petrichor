package assistantsvc

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

// Soft Router 只为技能预加载和提示词提供参考，任何失败都不能裁剪 Agent 能力。
type assistantRouteRule struct {
	domain  string
	pattern *regexp.Regexp
	weight  int
}

var assistantRouteRules = []assistantRouteRule{
	{domain: "content_write", pattern: regexp.MustCompile(`(?i)(新建|创建|写入|删除|移除|移动|迁移|移到|挪到|跨库|move[_-]?article|重命名|归档|上传|保存|发布|撤销分享|开启分享|公开分享|改标题|更新正文|编辑文章|帮我删|帮我建)`), weight: 3},
	{domain: "admin", pattern: regexp.MustCompile(`(?i)(模型配置|ai\s*配置|密钥|api\s*key|公开问答|公开站|吊销|配额|开关)`), weight: 3},
	{domain: "knowledge", pattern: regexp.MustCompile(`(?i)(知识库|文章|wiki|笔记)`), weight: 2},
	{domain: "doc_library", pattern: regexp.MustCompile(`(?i)(文档|文件|pdf|word|excel|csv)`), weight: 2},
	{domain: "system", pattern: regexp.MustCompile(`(?i)(多少|几个|统计|概览|状态|总数|系统|是否就绪|有没有配置)`), weight: 2},
}

var defaultAssistantReadDomains = []string{"system", "knowledge", "doc_library"}

func resolveAssistantRoutingHint(ctx context.Context, threadID int64, userText string, focus *assistantFocus) *rt.RoutingHint {
	recentTools, _ := listRecentAssistantToolNames(ctx, threadID)
	recentDomains, _ := listRecentAssistantIntentDomains(ctx, threadID)

	scores := map[string]int{}
	signals := []string{}
	bump := func(domain string, weight int, signal string) {
		scores[domain] += weight
		signals = append(signals, signal)
	}
	for _, rule := range assistantRouteRules {
		if rule.pattern.MatchString(userText) {
			bump(rule.domain, rule.weight, "text:"+rule.domain)
		}
	}
	if focus != nil {
		if focus.KnowledgeBaseID != nil || focus.ArticleID != nil {
			bump("knowledge", 4, "focus:knowledge")
		}
		if focus.LibraryID != nil || focus.DocumentID != nil {
			bump("doc_library", 4, "focus:doc_library")
		}
	}
	seenTools := map[string]bool{}
	for _, toolName := range recentTools {
		if seenTools[toolName] {
			continue
		}
		seenTools[toolName] = true
		if domain := assistantToolDomain(toolName); domain != "" {
			bump(domain, 1, "recent:"+toolName)
		}
	}

	type scoredDomain struct {
		domain string
		score  int
	}
	ranked := make([]scoredDomain, 0, len(scores))
	for domain, score := range scores {
		ranked = append(ranked, scoredDomain{domain: domain, score: score})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score == ranked[j].score {
			return ranked[i].domain < ranked[j].domain
		}
		return ranked[i].score > ranked[j].score
	})
	primary := make([]string, 0, 2)
	for _, item := range ranked {
		if len(primary) == 2 {
			break
		}
		primary = append(primary, item.domain)
	}

	stickyAdmin := containsRouteDomain(recentDomains, "admin")
	if len(primary) == 0 {
		domains := append([]string{}, defaultAssistantReadDomains...)
		if stickyAdmin {
			domains = withAssistantAuxiliaryDomains(append(domains, "admin"))
			return &rt.RoutingHint{Domains: domains, Confidence: 0.7, Reasoning: "no-signal:sticky-admin-domain"}
		}
		return &rt.RoutingHint{Domains: domains, Confidence: 0.3, Reasoning: "no-signal:default-read-domains"}
	}

	domains := withAssistantAuxiliaryDomains(primary)
	if stickyAdmin && !containsRouteDomain(domains, "admin") {
		domains = withAssistantAuxiliaryDomains(append(domains, "admin"))
		signals = append(signals, "sticky:admin")
	}
	confidence := 0.5 + float64(len(signals))*0.1
	if confidence > 0.9 {
		confidence = 0.9
	}
	return &rt.RoutingHint{Domains: domains, Confidence: confidence, Reasoning: strings.Join(signals, ",")}
}

func withAssistantAuxiliaryDomains(domains []string) []string {
	out := append([]string{}, domains...)
	if (containsRouteDomain(out, "knowledge") || containsRouteDomain(out, "doc_library")) && !containsRouteDomain(out, "system") {
		out = append(out, "system")
	}
	if containsRouteDomain(out, "admin") && !containsRouteDomain(out, "content_write") {
		out = append(out, "content_write")
	}
	return dedupeStrings(out)
}

func assistantToolDomain(toolName string) string {
	lower := strings.ToLower(toolName)
	switch {
	case strings.Contains(lower, "admin") || strings.Contains(lower, "model_config") || strings.Contains(lower, "api_key"):
		return "admin"
	case strings.Contains(lower, "document") || strings.Contains(lower, "library"):
		return "doc_library"
	case strings.Contains(lower, "knowledge") || strings.Contains(lower, "wiki") || strings.Contains(lower, "article"):
		return "knowledge"
	case strings.Contains(lower, "create") || strings.Contains(lower, "update") || strings.Contains(lower, "delete") || strings.Contains(lower, "move"):
		return "content_write"
	case strings.Contains(lower, "overview") || strings.Contains(lower, "status") || strings.Contains(lower, "list_"):
		return "system"
	default:
		return ""
	}
}

func listRecentAssistantToolNames(ctx context.Context, threadID int64) ([]string, error) {
	rows, err := dbPool().Query(ctx, `
		SELECT s.tool_name
		FROM petrichor_assistant_step s
		WHERE s.run_id = (
			SELECT r.id FROM petrichor_assistant_run r
			WHERE r.thread_id = $1
			ORDER BY r.started_at DESC, r.id DESC LIMIT 1
		)
		ORDER BY s.step_index ASC`, threadID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func listRecentAssistantIntentDomains(ctx context.Context, threadID int64) ([]string, error) {
	var raw *string
	err := dbPool().QueryRow(ctx, `
		SELECT intent_domains_json FROM petrichor_assistant_run
		WHERE thread_id = $1 ORDER BY started_at DESC, id DESC LIMIT 1`, threadID).Scan(&raw)
	if err != nil || raw == nil {
		return nil, err
	}
	var values []any
	if json.Unmarshal([]byte(*raw), &values) != nil {
		return []string{}, nil
	}
	out := []string{}
	for _, value := range values {
		if domain, ok := value.(string); ok {
			out = append(out, domain)
		}
	}
	return out, nil
}

func routingDomains(hint *rt.RoutingHint) []string {
	if hint == nil {
		return []string{}
	}
	return append([]string{}, hint.Domains...)
}

func containsRouteDomain(domains []string, target string) bool {
	for _, domain := range domains {
		if domain == target {
			return true
		}
	}
	return false
}

func dedupeStrings(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func assistantFocusMap(focus *assistantFocus) map[string]any {
	if focus == nil {
		return nil
	}
	out := map[string]any{}
	if focus.KnowledgeBaseID != nil {
		out["knowledgeBaseId"] = *focus.KnowledgeBaseID
	}
	if focus.LibraryID != nil {
		out["libraryId"] = *focus.LibraryID
	}
	if focus.ArticleID != nil {
		out["articleId"] = *focus.ArticleID
	}
	if focus.DocumentID != nil {
		out["documentId"] = *focus.DocumentID
	}
	return out
}

func assistantContextTokenLimit(modelLimit int64) int64 {
	const runtimeLimit int64 = 100_000
	if modelLimit > 0 && modelLimit < runtimeLimit {
		return modelLimit
	}
	return runtimeLimit
}
