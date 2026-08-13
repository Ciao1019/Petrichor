package assistant

import "regexp"

var writeIntentDomains = map[AgentDomainId]struct{}{
	DomainContentWrite: {},
	DomainAdmin:        {},
}

var domainPatterns = []struct {
	domain  AgentDomainId
	pattern *regexp.Regexp
	weight  int
}{
	{DomainContentWrite, regexp.MustCompile(`(?i)(新建|创建|写入|删除|移除|移动|迁移|移到|挪到|跨库|move[_-]?article|重命名|归档|上传|保存|发布|撤销分享|开启分享|公开分享|改标题|更新正文|编辑文章|帮我删|帮我建)`), 3},
	{DomainAdmin, regexp.MustCompile(`(?i)(模型配置|ai\s*配置|密钥|api\s*key|公开问答|公开站|吊销|配额|开关)`), 3},
	{DomainKnowledge, regexp.MustCompile(`(?i)(知识库|文章|wiki|笔记|文档|文件|pdf|word|excel|csv)`), 2},
	{DomainSystem, regexp.MustCompile(`(多少|几个|统计|概览|状态|总数|系统|是否就绪|有没有配置)`), 2},
}

const (
	focusDomainBoost        = 4
	maxPrimaryIntentDomains = 2
)

func hasAdminDomainCandidate(domains []AgentDomainId) bool {
	for _, d := range domains {
		if d == DomainAdmin {
			return true
		}
	}
	return false
}

func withAuxiliaryDomains(domains []AgentDomainId) []AgentDomainId {
	next := append([]AgentDomainId(nil), domains...)
	hasSystem := false
	hasContentWrite := false
	for _, d := range next {
		if d == DomainSystem {
			hasSystem = true
		}
		if d == DomainContentWrite {
			hasContentWrite = true
		}
	}
	if !hasSystem {
		for _, d := range next {
			if d == DomainKnowledge {
				next = append(next, DomainSystem)
				break
			}
		}
	}
	for _, d := range next {
		if d == DomainAdmin && !hasContentWrite {
			next = append(next, DomainContentWrite)
			break
		}
	}
	return next
}

func withStickyAdminDomain(domains []AgentDomainId, recentIntentDomains []AgentDomainId) []AgentDomainId {
	hasRecentAdmin := false
	for _, d := range recentIntentDomains {
		if d == DomainAdmin {
			hasRecentAdmin = true
			break
		}
	}
	if !hasRecentAdmin {
		return domains
	}
	for _, d := range domains {
		if d == DomainAdmin {
			return domains
		}
	}
	return withAuxiliaryDomains(append(domains, DomainAdmin))
}

// RouteAssistantIntent 规则启发式意图路由（无 LLM）。
func RouteAssistantIntent(userText string, focus *AssistantFocus, recentToolNames []string, recentIntentDomains []AgentDomainId) IntentRouteResult {
	scores := map[AgentDomainId]int{}
	signals := []string{}
	bump := func(domain AgentDomainId, weight int, signal string) {
		scores[domain] += weight
		signals = append(signals, signal)
	}
	for _, p := range domainPatterns {
		if p.pattern.MatchString(userText) {
			bump(p.domain, p.weight, "text:"+string(p.domain))
		}
	}
	if focus != nil {
		if focus.KnowledgeBaseID != nil || focus.ArticleID != nil {
			bump(DomainKnowledge, focusDomainBoost, "focus:knowledge")
		}
		if focus.DocumentID != nil {
			bump(DomainKnowledge, focusDomainBoost, "focus:document")
		}
	}
	seen := map[string]struct{}{}
	for _, name := range recentToolNames {
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		if domain := GetToolDomain(name); domain != "" {
			bump(domain, 1, "recent:"+name)
		}
	}
	type scored struct {
		domain AgentDomainId
		score  int
	}
	ranked := make([]scored, 0, len(scores))
	for d, s := range scores {
		ranked = append(ranked, scored{d, s})
	}
	for i := 0; i < len(ranked); i++ {
		for j := i + 1; j < len(ranked); j++ {
			if ranked[j].score > ranked[i].score {
				ranked[i], ranked[j] = ranked[j], ranked[i]
			}
		}
	}
	primary := make([]AgentDomainId, 0, maxPrimaryIntentDomains)
	for i := 0; i < len(ranked) && i < maxPrimaryIntentDomains; i++ {
		primary = append(primary, ranked[i].domain)
	}
	if len(primary) == 0 {
		stickyOnly := withStickyAdminDomain(append([]AgentDomainId(nil), DefaultReadDomains...), recentIntentDomains)
		conf := 0.3
		rationale := "no-signal:default-read-domains"
		if hasAdminDomainCandidate(stickyOnly) {
			for _, d := range recentIntentDomains {
				if d == DomainAdmin {
					conf = 0.7
					rationale = "no-signal:sticky-admin-domain"
					break
				}
			}
		}
		return IntentRouteResult{Domains: stickyOnly, Confidence: conf, Rationale: rationale, Source: "rules"}
	}
	domains := withStickyAdminDomain(withAuxiliaryDomains(primary), recentIntentDomains)
	conf := 0.5 + float64(len(signals))*0.1
	if conf > 0.9 {
		conf = 0.9
	}
	rationale := joinSignals(signals)
	for _, d := range recentIntentDomains {
		if d == DomainAdmin {
			for _, cd := range domains {
				if cd == DomainAdmin {
					rationale += ",sticky:admin"
					break
				}
			}
			break
		}
	}
	return IntentRouteResult{Domains: domains, Confidence: conf, Rationale: rationale, Source: "rules"}
}

func joinSignals(signals []string) string {
	if len(signals) == 0 {
		return ""
	}
	out := signals[0]
	for i := 1; i < len(signals); i++ {
		out += "," + signals[i]
	}
	return out
}

func ToIntentRoutePartData(route IntentRouteResult, status string) IntentRoutePartData {
	if status == "running" {
		return IntentRoutePartData{Status: "running", Label: "正在识别意图…"}
	}
	source := route.Source
	if source == "" {
		source = "rules"
	}
	return IntentRoutePartData{
		Status:     "done",
		Source:     source,
		Domains:    route.Domains,
		Confidence: route.Confidence,
		Rationale:  route.Rationale,
		Label:      FormatIntentRouteLabel(route.Domains, source, route.Confidence),
	}
}

func NeedsIntentLLM(route IntentRouteResult) bool {
	return route.Confidence < 0.5 || hasAdminDomainCandidate(route.Domains)
}
