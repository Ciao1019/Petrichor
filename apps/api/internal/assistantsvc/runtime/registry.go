package runtime

// AgentToolRegistry 统一工具注册表（对照 tool-registry.ts）。
//
// 所有 Agent 可用工具都必须在此注册：Runtime、Skill、SubAgent 都只从这里取工具。
type AgentToolRegistry struct {
	byID   map[string]*AgentToolDefinition
	byName map[string]string
}

// NewToolRegistry 构造。
func NewToolRegistry() *AgentToolRegistry {
	return &AgentToolRegistry{byID: map[string]*AgentToolDefinition{}, byName: map[string]string{}}
}

// Register 注册单个工具。
func (r *AgentToolRegistry) Register(definition *AgentToolDefinition) {
	r.byID[definition.ID] = definition
	r.byName[definition.Name] = definition.ID
}

// RegisterMany 批量注册。
func (r *AgentToolRegistry) RegisterMany(definitions []*AgentToolDefinition) {
	for _, d := range definitions {
		r.Register(d)
	}
}

// Get 按 id 或公开名取工具。
func (r *AgentToolRegistry) Get(toolID string) *AgentToolDefinition {
	if tool, ok := r.byID[toolID]; ok {
		return tool
	}
	if id, ok := r.byName[toolID]; ok {
		return r.byID[id]
	}
	return nil
}

// Has 工具是否已注册。
func (r *AgentToolRegistry) Has(toolID string) bool { return r.Get(toolID) != nil }

// IDs 全部 id。
func (r *AgentToolRegistry) IDs() []string {
	out := make([]string, 0, len(r.byID))
	for id := range r.byID {
		out = append(out, id)
	}
	return out
}

// ToolFilter 列表过滤条件。
type ToolFilter struct {
	Namespace         ToolNamespace
	Core              *bool
	SideEffect        *bool
	AllowedInSubAgent *bool
	IsOperator        *bool
}

// List 按条件列出。
func (r *AgentToolRegistry) List(filter *ToolFilter) []*AgentToolDefinition {
	out := make([]*AgentToolDefinition, 0)
	for _, tool := range r.byID {
		if filter == nil {
			out = append(out, tool)
			continue
		}
		if filter.Namespace != "" && tool.Namespace != filter.Namespace {
			continue
		}
		if filter.Core != nil && tool.Core != *filter.Core {
			continue
		}
		if filter.SideEffect != nil && tool.SideEffect != *filter.SideEffect {
			continue
		}
		if filter.AllowedInSubAgent != nil && tool.AllowsSubAgent() != *filter.AllowedInSubAgent {
			continue
		}
		if filter.IsOperator != nil && !*filter.IsOperator && tool.RequiresOperator {
			continue
		}
		out = append(out, tool)
	}
	return out
}

// CoreToolIDs 主 Agent 默认核心工具集：控制在 5~10 个，其余靠 load_skill 解锁。
func (r *AgentToolRegistry) CoreToolIDs(isOperator bool) []string {
	core := true
	op := isOperator
	tools := r.List(&ToolFilter{Core: &core, IsOperator: &op})
	ids := make([]string, 0, len(tools))
	for _, t := range tools {
		ids = append(ids, t.ID)
	}
	return ids
}

// IsHighRiskTool 高危工具判定：写副作用 + 非 low 风险。
func IsHighRiskTool(tool *AgentToolDefinition) bool {
	return tool.RiskLevel == RiskHigh || (tool.SideEffect && tool.RiskLevel != RiskLow)
}

// RenderToolCatalogLine 供 prompt 使用的工具描述行。
func RenderToolCatalogLine(tool *AgentToolDefinition) string {
	marks := ""
	if tool.SideEffect {
		marks = "有副作用"
	}
	if tool.RequiresConfirmation {
		if marks != "" {
			marks += "，"
		}
		marks += "需确认"
	}
	suffix := ""
	if marks != "" {
		suffix = "（" + marks + "）"
	}
	return "- " + tool.ID + suffix + "：" + tool.Description
}
