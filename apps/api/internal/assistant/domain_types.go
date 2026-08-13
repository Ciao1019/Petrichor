package assistant

import "strconv"

// AgentDomainId 工具域标识，对齐前端契约。
type AgentDomainId string

const (
	DomainKnowledge    AgentDomainId = "knowledge"
	DomainSystem       AgentDomainId = "system"
	DomainContentWrite AgentDomainId = "content_write"
	DomainAdmin        AgentDomainId = "admin"
)

var DefaultReadDomains = []AgentDomainId{DomainSystem, DomainKnowledge}

var CoreSessionDomains = []AgentDomainId{
	DomainSystem, DomainKnowledge, DomainContentWrite,
}

const (
	IntentRoutePartType     = "data-intent-route"
	ContextCompressPartType = "data-context-compress"
	StepBudgetPartType      = "data-step-budget"

	AssistantMaxStepsRead  = 12
	AssistantMaxStepsWrite = 20
)

type AssistantFocus struct {
	KnowledgeBaseID *string `json:"knowledgeBaseId,omitempty"`
	ArticleID       *string `json:"articleId,omitempty"`
	DocumentID      *string `json:"documentId,omitempty"`
}

type IntentRouteResult struct {
	Domains    []AgentDomainId `json:"domains"`
	Confidence float64         `json:"confidence"`
	Rationale  string          `json:"rationale,omitempty"`
	Source     string          `json:"source,omitempty"`
}

type IntentRoutePartData struct {
	Status     string          `json:"status"`
	Source     string          `json:"source,omitempty"`
	Domains    []AgentDomainId `json:"domains,omitempty"`
	Confidence float64         `json:"confidence,omitempty"`
	Rationale  string          `json:"rationale,omitempty"`
	Label      string          `json:"label"`
}

type ContextCompressPartData struct {
	Status string `json:"status"`
	Label  string `json:"label"`
}

type StepBudgetPartData struct {
	Status string `json:"status"`
	Used   int    `json:"used"`
	Limit  int    `json:"limit"`
	Label  string `json:"label"`
}

var domainLabels = map[AgentDomainId]string{
	DomainKnowledge:    "知识库",
	DomainSystem:       "系统",
	DomainContentWrite: "内容写入",
	DomainAdmin:        "管理",
}

func ResolveToolLoadDomains(intentDomains []AgentDomainId) []AgentDomainId {
	next := make(map[AgentDomainId]struct{})
	for _, d := range CoreSessionDomains {
		next[d] = struct{}{}
	}
	for _, d := range intentDomains {
		if d == DomainAdmin {
			next[DomainAdmin] = struct{}{}
		}
	}
	out := make([]AgentDomainId, 0, len(next))
	for _, d := range CoreSessionDomains {
		if _, ok := next[d]; ok {
			out = append(out, d)
		}
	}
	if _, ok := next[DomainAdmin]; ok {
		out = append(out, DomainAdmin)
	}
	return out
}

func ResolveAssistantMaxSteps(intentDomains []AgentDomainId) int {
	for _, d := range intentDomains {
		if d == DomainContentWrite || d == DomainAdmin {
			return AssistantMaxStepsWrite
		}
	}
	return AssistantMaxStepsRead
}

func FormatIntentRouteLabel(domains []AgentDomainId, source string, confidence float64) string {
	parts := make([]string, 0, len(domains))
	for _, d := range domains {
		if label, ok := domainLabels[d]; ok {
			parts = append(parts, label)
		} else {
			parts = append(parts, string(d))
		}
	}
	sourceText := "规则"
	if source == "llm" {
		sourceText = "智能识别"
	}
	domainText := ""
	for i, p := range parts {
		if i > 0 {
			domainText += " · "
		}
		domainText += p
	}
	return domainText + "（" + sourceText + " · " + fmtPercent(confidence) + "）"
}

func fmtPercent(confidence float64) string {
	pct := int(confidence * 100)
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return fmtInt(pct) + "%"
}

func fmtInt(n int) string {
	return strconv.Itoa(n)
}
