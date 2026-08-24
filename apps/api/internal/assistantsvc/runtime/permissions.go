package runtime

// ===== 统一权限解析（对照 permissions.ts）=====

// PERMISSIONS 已知权限位；工具通过 ToolDefinition.Permissions 声明所需权限。
const (
	PermissionOperator    = "assistant.operator"
	PermissionAdmin       = "assistant.admin"
	PermissionWrite       = "assistant.write"
	PermissionMemoryWrite = "assistant.memory.write"
)

// PermissionContext 权限判定上下文。
type PermissionContext struct {
	UserID          int64
	SystemRole      string
	DelegationDepth int
	AllowedToolIDs  []string
}

// PermissionDecision 判定结果。
type PermissionDecision struct {
	Allowed bool
	Reason  string
}

// IsAssistantOperator 操作员判定（对照 operator-gate.ts）：
// systemRole 为 admin/operator 或超级管理员视为操作员。
func IsAssistantOperator(systemRole string) bool {
	switch normalizeOperatorRole(systemRole) {
	case "admin", "operator", "super_admin", "SUPER_ADMIN", "ADMIN":
		return true
	}
	return false
}

func normalizeOperatorRole(role string) string { return trimSpace(role) }

// PermissionResolver 权限解析接口。
type PermissionResolver interface {
	CanUseTool(userID int64, toolID string, ctx PermissionContext) PermissionDecision
}

// DefaultPermissionResolver 默认实现。
type DefaultPermissionResolver struct {
	getTool func(toolID string) *AgentToolDefinition
}

// NewDefaultPermissionResolver 构造。
func NewDefaultPermissionResolver(getTool func(toolID string) *AgentToolDefinition) *DefaultPermissionResolver {
	return &DefaultPermissionResolver{getTool: getTool}
}

// CanUseTool 三条硬约束：主/子代理都必须过这一层；委派不提权；加载技能只扩大可见能力。
func (r *DefaultPermissionResolver) CanUseTool(userID int64, toolID string, ctx PermissionContext) PermissionDecision {
	tool := r.getTool(toolID)
	if tool == nil {
		return PermissionDecision{Allowed: false, Reason: "未注册的工具：" + toolID}
	}

	if ctx.DelegationDepth > 0 {
		if !tool.AllowsSubAgent() {
			return PermissionDecision{Allowed: false, Reason: "工具 " + toolID + " 不允许在子代理中使用"}
		}
		if ctx.AllowedToolIDs != nil && !containsString(ctx.AllowedToolIDs, toolID) {
			return PermissionDecision{Allowed: false, Reason: "工具 " + toolID + " 不在本次委派的授权范围内"}
		}
	}

	isOperator := IsAssistantOperator(ctx.SystemRole)
	if tool.RequiresOperator && !isOperator {
		return PermissionDecision{Allowed: false, Reason: "工具 " + toolID + " 仅限操作员使用"}
	}

	for _, permission := range tool.Permissions {
		if decision := checkPermission(permission, isOperator); !decision.Allowed {
			return decision
		}
	}
	return PermissionDecision{Allowed: true}
}

func checkPermission(permission string, isOperator bool) PermissionDecision {
	switch permission {
	case PermissionOperator, PermissionAdmin:
		if isOperator {
			return PermissionDecision{Allowed: true}
		}
		return PermissionDecision{Allowed: false, Reason: "缺少权限：" + permission}
	default:
		// write / memoryWrite 由具体业务 handler 再做资源级校验，这里只拦明显越权
		return PermissionDecision{Allowed: true}
	}
}

// IntersectToolScope 委派工具白名单求交：子代理请求的工具 ∩ 父级实际可用工具。
func IntersectToolScope(parentAllowed []string, requested []string, registryToolIDs []string) []string {
	parentSet := map[string]bool{}
	if parentAllowed != nil {
		for _, id := range parentAllowed {
			parentSet[id] = true
		}
	} else {
		for _, id := range registryToolIDs {
			parentSet[id] = true
		}
	}
	if len(requested) == 0 {
		out := make([]string, 0, len(parentSet))
		for id := range parentSet {
			out = append(out, id)
		}
		return out
	}
	out := make([]string, 0, len(requested))
	for _, id := range requested {
		if parentSet[id] {
			out = append(out, id)
		}
	}
	return out
}
