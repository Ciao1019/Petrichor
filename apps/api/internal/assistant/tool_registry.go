package assistant

import (
	"github.com/cloudwego/eino/components/tool"
)

// ToolRisk 工具风险级别。
type ToolRisk string

const (
	RiskRead      ToolRisk = "read"
	RiskWrite     ToolRisk = "write"
	RiskDangerous ToolRisk = "dangerous"
)

// ToolRegistration 进程内工具注册项。
type ToolRegistration struct {
	Name             string
	Domain           AgentDomainId
	Risk             ToolRisk
	Description      string
	RequiresOperator bool
	Factory          func() tool.InvokableTool
}

var toolRegistry = map[string]*ToolRegistration{}

func registerTools(items []ToolRegistration) {
	for i := range items {
		item := items[i]
		toolRegistry[item.Name] = &item
	}
}

func GetToolRegistration(name string) *ToolRegistration {
	return toolRegistry[name]
}

func GetToolDomain(name string) AgentDomainId {
	if reg := toolRegistry[name]; reg != nil {
		return reg.Domain
	}
	return ""
}

func loadToolsForDomains(domains []AgentDomainId, isOperator bool) []tool.BaseTool {
	wanted := map[AgentDomainId]struct{}{}
	for _, d := range domains {
		wanted[d] = struct{}{}
	}
	out := make([]tool.BaseTool, 0, 32)
	for _, reg := range toolRegistry {
		if _, ok := wanted[reg.Domain]; !ok {
			continue
		}
		if reg.Risk == RiskDangerous {
			continue
		}
		if reg.RequiresOperator && !isOperator {
			continue
		}
		out = append(out, reg.Factory())
	}
	return out
}

func listRegisteredToolNames() []string {
	names := make([]string, 0, len(toolRegistry))
	for name := range toolRegistry {
		names = append(names, name)
	}
	return names
}
