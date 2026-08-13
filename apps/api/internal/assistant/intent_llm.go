package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
)

const (
	intentLLMConfidenceThreshold = 0.5
	intentLLMTimeout             = 5 * time.Second
)

type intentLLMObject struct {
	Domains    []string `json:"domains"`
	Confidence float64  `json:"confidence"`
	Rationale  string   `json:"rationale"`
}

// RouteAssistantIntentWithLLM 规则优先；低置信度或 admin 候选时用轻量 JSON 分类覆盖。
// LLM 失败时静默回退规则结果，不阻断对话。
func RouteAssistantIntentWithLLM(
	ctx context.Context,
	gen *ai.Generation,
	modelCfg *ent.AIModelConfig,
	userText string,
	focus *AssistantFocus,
	recentToolNames []string,
	recentIntentDomains []AgentDomainId,
	rulesRoute *IntentRouteResult,
) IntentRouteResult {
	rules := IntentRouteResult{}
	if rulesRoute != nil {
		rules = *rulesRoute
	} else {
		rules = RouteAssistantIntent(userText, focus, recentToolNames, recentIntentDomains)
	}
	finalize := func(route IntentRouteResult) IntentRouteResult {
		route.Domains = withStickyAdminDomain(route.Domains, recentIntentDomains)
		if route.Source == "" {
			route.Source = "rules"
		}
		return route
	}
	rulesResult := finalize(IntentRouteResult{
		Domains:    rules.Domains,
		Confidence: rules.Confidence,
		Rationale:  rules.Rationale,
		Source:     "rules",
	})
	if !NeedsIntentLLM(rules) || gen == nil || modelCfg == nil {
		return rulesResult
	}
	rulesHadAdmin := hasAdminDomainCandidate(rules.Domains)

	llmCtx, cancel := context.WithTimeout(ctx, intentLLMTimeout)
	defer cancel()
	llm, err := classifyIntentWithLLM(llmCtx, gen, modelCfg, userText, focus, recentToolNames, recentIntentDomains, rules)
	if err != nil {
		if rulesHadAdmin {
			rulesResult.Rationale = rules.Rationale + ";admin-domain-kept-on-llm-failure"
			return finalize(rulesResult)
		}
		return finalize(rulesResult)
	}
	merged := mergeAdminDomainFromRules(llm.Domains, rules.Domains)
	if merged.kept {
		llm.Rationale = llm.Rationale + ";admin-domain-kept-from-rules"
	}
	llm.Domains = merged.domains
	return finalize(llm)
}

func classifyIntentWithLLM(
	ctx context.Context,
	gen *ai.Generation,
	modelCfg *ent.AIModelConfig,
	userText string,
	focus *AssistantFocus,
	recentToolNames []string,
	recentIntentDomains []AgentDomainId,
	rules IntentRouteResult,
) (IntentRouteResult, error) {
	system := strings.Join([]string{
		"你是 Petrichor 站内助手的意图分类器。",
		"只输出 JSON，选择本轮需要装载的工具域。",
		`格式：{"domains":["knowledge"],"confidence":0.8,"rationale":"短句"}`,
		"可选域：knowledge、system、content_write、admin。",
		"domains 数量 1~2。",
		"用户明确要求改配置/密钥/公开问答开关时必须含 admin。",
		"上一轮意图域已含 admin 时，除非用户明确改聊无关只读话题，否则继续包含 admin。",
		"知识库问答通常同时含 system。",
		"rationale 用中文短句，不超过 80 字。",
		"不要编造域。",
	}, "\n")
	prompt := strings.Join([]string{
		fmt.Sprintf("用户消息：%s", emptyHint(userText)),
		fmt.Sprintf("当前 focus：%s", summarizeFocus(focus)),
		fmt.Sprintf("近期工具：%s", joinOrNone(recentToolNames)),
		fmt.Sprintf("上一轮意图域：%s", joinDomainsOrNone(recentIntentDomains)),
		fmt.Sprintf("规则初筛 domains：%s", joinDomainsOrNone(rules.Domains)),
		fmt.Sprintf("规则置信度：%.2f", rules.Confidence),
		fmt.Sprintf("规则 rationale：%s", rules.Rationale),
	}, "\n")

	result, err := gen.Chat(ctx, modelCfg, []ai.ChatMessage{
		{Role: "system", Content: system},
		{Role: "user", Content: prompt},
	})
	if err != nil {
		return IntentRouteResult{}, err
	}
	obj, err := parseIntentLLMJSON(result.Content)
	if err != nil {
		return IntentRouteResult{}, err
	}
	domains := make([]AgentDomainId, 0, maxPrimaryIntentDomains)
	seen := map[AgentDomainId]struct{}{}
	for _, raw := range obj.Domains {
		d := AgentDomainId(strings.TrimSpace(raw))
		if !isValidDomain(d) {
			continue
		}
		if _, ok := seen[d]; ok {
			continue
		}
		seen[d] = struct{}{}
		domains = append(domains, d)
		if len(domains) >= maxPrimaryIntentDomains {
			break
		}
	}
	if len(domains) == 0 {
		return IntentRouteResult{}, fmt.Errorf("意图 LLM 未返回有效 domains")
	}
	conf := obj.Confidence
	if conf < 0 {
		conf = 0
	}
	if conf > 1 {
		conf = 1
	}
	rationale := strings.TrimSpace(obj.Rationale)
	if rationale == "" {
		rationale = "llm"
	}
	if len([]rune(rationale)) > 80 {
		rationale = string([]rune(rationale)[:80])
	}
	return IntentRouteResult{
		Domains:    withAuxiliaryDomains(domains),
		Confidence: conf,
		Rationale:  rationale,
		Source:     "llm",
	}, nil
}

func parseIntentLLMJSON(raw string) (intentLLMObject, error) {
	text := strings.TrimSpace(raw)
	text = stripJSONFence(text)
	if obj, ok := tryUnmarshalIntent(text); ok {
		return obj, nil
	}
	re := regexp.MustCompile(`\{[\s\S]*\}`)
	loc := re.FindString(text)
	if loc == "" {
		return intentLLMObject{}, fmt.Errorf("未找到 JSON 对象")
	}
	if obj, ok := tryUnmarshalIntent(loc); ok {
		return obj, nil
	}
	return intentLLMObject{}, fmt.Errorf("意图 JSON 解析失败")
}

func tryUnmarshalIntent(raw string) (intentLLMObject, bool) {
	var obj intentLLMObject
	if err := json.Unmarshal([]byte(raw), &obj); err != nil {
		return intentLLMObject{}, false
	}
	return obj, true
}

func stripJSONFence(s string) string {
	s = strings.TrimSpace(s)
	if strings.HasPrefix(s, "```") {
		s = strings.TrimPrefix(s, "```json")
		s = strings.TrimPrefix(s, "```JSON")
		s = strings.TrimPrefix(s, "```")
		if idx := strings.LastIndex(s, "```"); idx >= 0 {
			s = s[:idx]
		}
	}
	return strings.TrimSpace(s)
}

type mergeAdminResult struct {
	domains []AgentDomainId
	kept    bool
}

func mergeAdminDomainFromRules(llmDomains, rulesDomains []AgentDomainId) mergeAdminResult {
	if !hasAdminDomainCandidate(rulesDomains) {
		return mergeAdminResult{domains: llmDomains}
	}
	if hasAdminDomainCandidate(llmDomains) {
		return mergeAdminResult{domains: llmDomains}
	}
	return mergeAdminResult{domains: withAuxiliaryDomains(append(append([]AgentDomainId{}, llmDomains...), DomainAdmin)), kept: true}
}

func isValidDomain(d AgentDomainId) bool {
	switch d {
	case DomainKnowledge, DomainSystem, DomainContentWrite, DomainAdmin:
		return true
	default:
		return false
	}
}

func summarizeFocus(focus *AssistantFocus) string {
	if focus == nil {
		return "无"
	}
	parts := make([]string, 0, 4)
	if focus.KnowledgeBaseID != nil {
		parts = append(parts, "knowledgeBaseId="+*focus.KnowledgeBaseID)
	}
	if focus.ArticleID != nil {
		parts = append(parts, "articleId="+*focus.ArticleID)
	}
	if focus.DocumentID != nil {
		parts = append(parts, "documentId="+*focus.DocumentID)
	}
	if len(parts) == 0 {
		return "无"
	}
	return strings.Join(parts, ", ")
}

func emptyHint(s string) string {
	if strings.TrimSpace(s) == "" {
		return "（空）"
	}
	return s
}

func joinOrNone(items []string) string {
	if len(items) == 0 {
		return "无"
	}
	limit := 8
	if len(items) < limit {
		limit = len(items)
	}
	return strings.Join(items[:limit], ", ")
}

func joinDomainsOrNone(domains []AgentDomainId) string {
	if len(domains) == 0 {
		return "无"
	}
	parts := make([]string, len(domains))
	for i, d := range domains {
		parts[i] = string(d)
	}
	return strings.Join(parts, ", ")
}
