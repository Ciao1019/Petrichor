package assistant

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
)

const (
	spawnResearchSubagentName = "spawn_research_subagent"
	spawnResearchFanoutName   = "spawn_research_fanout"
	spawnWriteSubagentName    = "spawn_write_subagent"
	proposeWriteActionsName   = "propose_write_actions"
)

var blockedSubagentTools = map[string]struct{}{
	spawnResearchSubagentName:   {},
	spawnResearchFanoutName:     {},
	spawnWriteSubagentName:      {},
	"save_answer_artifact":      {},
	"upsert_plan":               {},
	"request_user_confirmation": {},
	"create_article":            {},
	"update_article":            {},
	"create_article_share":      {},
	"move_article":              {},
	"set_default_ai_config":     {},
	"list_ai_configs":           {},
	"list_agent_api_keys":       {},
	"get_public_qa_setting":     {},
}

var blockedWriteSubagentTools = map[string]struct{}{
	spawnWriteSubagentName:      {},
	spawnResearchSubagentName:   {},
	spawnResearchFanoutName:     {},
	"save_answer_artifact":      {},
	"upsert_plan":               {},
	"request_user_confirmation": {},
	"create_article":            {},
	"update_article":            {},
	"create_article_share":      {},
	"move_article":              {},
	"delete_article":            {},
	"revoke_article_share":      {},
	"delete_document":           {},
	"set_default_ai_config":     {},
	"list_ai_configs":           {},
	"list_agent_api_keys":       {},
	"get_public_qa_setting":     {},
}

var writeProposalToolRisk = map[string]string{
	"create_article":       "write",
	"update_article":       "write",
	"create_article_share": "write",
	"move_article":         "write",
	"delete_article":       "dangerous",
	"revoke_article_share": "dangerous",
	"delete_document":      "dangerous",
}

func registerResearchTools() {
	registerTools([]ToolRegistration{
		{Name: spawnResearchSubagentName, Domain: DomainSystem, Risk: RiskRead, Description: "委派只读研究子代理。", Factory: newSpawnResearchSubagentTool},
		{Name: spawnResearchFanoutName, Domain: DomainSystem, Risk: RiskRead, Description: "并行多路研究子代理。", Factory: newSpawnResearchFanoutTool},
		{Name: spawnWriteSubagentName, Domain: DomainContentWrite, Risk: RiskRead, Description: "委派写入规划子代理。", Factory: newSpawnWriteSubagentTool},
		{Name: proposeWriteActionsName, Domain: DomainContentWrite, Risk: RiskRead, Description: "提议写入动作清单。", Factory: newProposeWriteActionsTool},
	})
}

type spawnResearchInput struct {
	Goal     string   `json:"goal"`
	Domains  []string `json:"domains"`
	Depth    *int     `json:"depth"`
	MaxDepth *int     `json:"maxDepth"`
}

func newSpawnResearchSubagentTool() tool.InvokableTool {
	t, err := utils.InferTool(spawnResearchSubagentName, "派生子代理做只读深度检索（可跨知识库与文件语料）。返回 summary 与可选 citations。", func(ctx context.Context, input *spawnResearchInput) (map[string]any, error) {
		return spawnResearchSubagent(ctx, input)
	})
	if err != nil {
		panic(err)
	}
	return t
}

type spawnFanoutInput struct {
	Goal  string   `json:"goal"`
	Tasks []string `json:"tasks"`
}

func newSpawnResearchFanoutTool() tool.InvokableTool {
	t, err := utils.InferTool(spawnResearchFanoutName, "并行委派多路只读研究子代理（最多 3 路）。", func(ctx context.Context, input *spawnFanoutInput) (map[string]any, error) {
		tasks := input.Tasks
		if len(tasks) == 0 && strings.TrimSpace(input.Goal) != "" {
			tasks = []string{input.Goal}
		}
		if len(tasks) == 0 {
			return nil, fmt.Errorf("tasks 不能为空")
		}
		if len(tasks) > 3 {
			tasks = tasks[:3]
		}
		type item struct {
			Task string
			Out  map[string]any
		}
		results := make([]item, len(tasks))
		var wg sync.WaitGroup
		for i, task := range tasks {
			wg.Add(1)
			go func(idx int, goal string) {
				defer wg.Done()
				out, err := spawnResearchSubagent(ctx, &spawnResearchInput{
					Goal:    goal,
					Domains: []string{"knowledge", "system"},
				})
				if err != nil {
					out = map[string]any{"ok": false, "summary": err.Error(), "errorCode": "subagent_failed"}
				}
				results[idx] = item{Task: goal, Out: out}
			}(i, task)
		}
		wg.Wait()
		payload := make([]map[string]any, 0, len(results))
		for _, r := range results {
			row := map[string]any{"task": r.Task}
			for k, v := range r.Out {
				row[k] = v
			}
			payload = append(payload, row)
		}
		return map[string]any{"ok": true, "results": payload}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type proposedWriteAction struct {
	ToolName string         `json:"toolName"`
	Input    map[string]any `json:"input"`
	Reason   string         `json:"reason,omitempty"`
	Risk     string         `json:"risk"`
}

type spawnWriteInput struct {
	Goal            string                `json:"goal"`
	ProposedActions []proposedWriteAction `json:"proposedActions"`
}

func newSpawnWriteSubagentTool() tool.InvokableTool {
	t, err := utils.InferTool(spawnWriteSubagentName, "派生子代理规划内容写入方案（只读检索 + propose_write_actions）。危险项须主助手确认。", func(ctx context.Context, input *spawnWriteInput) (map[string]any, error) {
		return spawnWriteSubagent(ctx, input)
	})
	if err != nil {
		panic(err)
	}
	return t
}

type proposeWriteActionsInput struct {
	Actions []proposedWriteAction `json:"actions"`
}

func newProposeWriteActionsTool() tool.InvokableTool {
	t, err := utils.InferTool(proposeWriteActionsName, "向主助手提交拟执行的内容写入/危险操作清单（本工具不真正执行）。", func(ctx context.Context, input *proposeWriteActionsInput) (map[string]any, error) {
		actions := normalizeProposedWriteActions(input.Actions)
		if bucket := proposalBucketFrom(ctx); bucket != nil {
			bucket.actions = actions
		}
		return map[string]any{
			"ok":       len(actions) > 0,
			"accepted": len(actions),
			"actions":  actions,
			"message":  "提案已记录，等待主助手执行或确认。",
		}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func spawnResearchSubagent(ctx context.Context, input *spawnResearchInput) (map[string]any, error) {
	goal := strings.TrimSpace(input.Goal)
	if goal == "" {
		return nil, fmt.Errorf("goal 不能为空")
	}
	rt := runtimeFrom(ctx)
	if rt == nil {
		return map[string]any{"ok": false, "summary": "缺少 Runtime", "errorCode": "tool_error"}, nil
	}
	userID, err := userIDFrom(ctx)
	if err != nil {
		return nil, err
	}
	depth, maxDepth := resolveSpawnDepthPolicy(ctx, input.Depth, input.MaxDepth)
	if depth > maxDepth {
		return map[string]any{
			"ok": false, "summary": fmt.Sprintf("子代理深度超限：depth=%d > maxDepth=%d", depth, maxDepth),
			"depth": depth, "maxDepth": maxDepth, "errorCode": "subagent_depth_exceeded",
		}, nil
	}
	domains := sanitizeResearchDomains(input.Domains)
	allowRespawn := depth < maxDepth
	stepPrefix := spawnResearchSubagentName
	if depth > 0 {
		stepPrefix = fmt.Sprintf("%s/d%d", spawnResearchSubagentName, depth)
	}
	modelCfg, _ := rt.resolveChatModelConfig(ctx, userID, nil)
	result, err := runNestedAgentGenerate(ctx, nestedAgentOptions{
		Runtime:      rt,
		UserID:       userID,
		ThreadID:     threadIDFrom(ctx),
		RunID:        runIDFrom(ctx),
		SystemRole:   systemRoleFrom(ctx),
		Focus:        focusFrom(ctx),
		ModelCfg:     modelCfg,
		AgentName:    "Petrichor Research Subagent",
		Instructions: buildResearchSubagentInstructions(goal, depth, maxDepth),
		Domains:      domains,
		FilterToolNames: func(names []string) []string {
			return filterSubagentToolNames(names, allowRespawn)
		},
		Prompt:        goal,
		MaxSteps:      subagentMaxSteps,
		Timeout:       subagentTimeout,
		StepPrefix:    stepPrefix,
		SpawnDepth:    depth,
		SpawnMaxDepth: maxDepth,
	})
	if err != nil {
		code := "tool_error"
		if strings.Contains(err.Error(), "subagent_timeout") {
			code = "tool_timeout"
		}
		return map[string]any{
			"ok": false, "summary": "子代理失败：" + err.Error(),
			"depth": depth, "maxDepth": maxDepth, "errorCode": code,
		}, nil
	}
	ok := result.Text != ""
	out := map[string]any{
		"ok": ok, "summary": result.Text,
		"usage": map[string]any{"calls": result.ToolCalls, "totalTokens": 0},
		"steps": result.Steps, "depth": depth, "maxDepth": maxDepth,
	}
	if !ok {
		out["summary"] = "子代理未产出可读结论"
		out["errorCode"] = "empty_summary"
	}
	recordNestedStep(ctx, rt.client, runIDFrom(ctx), stepPrefix, "summary", out, ok, "")
	return out, nil
}

func spawnWriteSubagent(ctx context.Context, input *spawnWriteInput) (map[string]any, error) {
	goal := strings.TrimSpace(input.Goal)
	if goal == "" {
		return nil, fmt.Errorf("goal 不能为空")
	}
	rt := runtimeFrom(ctx)
	if rt == nil {
		return map[string]any{"ok": false, "summary": "缺少 Runtime", "errorCode": "tool_error", "proposedActions": []any{}}, nil
	}
	userID, err := userIDFrom(ctx)
	if err != nil {
		return nil, err
	}
	seed := normalizeProposedWriteActions(input.ProposedActions)
	bucket := &proposalBucket{actions: append([]proposedWriteAction{}, seed...)}
	proposeTool := newProposeWriteActionsTool()
	modelCfg, _ := rt.resolveChatModelConfig(ctx, userID, nil)
	subCtx := context.WithValue(ctx, ctxKeyProposalBucket{}, bucket)
	result, err := runNestedAgentGenerate(subCtx, nestedAgentOptions{
		Runtime:         rt,
		UserID:          userID,
		ThreadID:        threadIDFrom(ctx),
		RunID:           runIDFrom(ctx),
		SystemRole:      systemRoleFrom(ctx),
		Focus:           focusFrom(ctx),
		ModelCfg:        modelCfg,
		AgentName:       "Petrichor Write Subagent",
		Instructions:    buildWriteSubagentInstructions(goal, seed),
		Domains:         []AgentDomainId{DomainKnowledge, DomainSystem},
		FilterToolNames: filterWriteSubagentToolNames,
		AugmentTools:    []tool.BaseTool{proposeTool},
		Prompt:          goal,
		MaxSteps:        subagentMaxSteps,
		Timeout:         subagentTimeout,
		StepPrefix:      spawnWriteSubagentName,
	})
	if err != nil {
		code := "tool_error"
		if strings.Contains(err.Error(), "subagent_timeout") {
			code = "tool_timeout"
		}
		return map[string]any{
			"ok": false, "summary": "写子代理失败：" + err.Error(),
			"proposedActions": bucket.actions, "errorCode": code,
		}, nil
	}
	actions := bucket.actions
	ok := result.Text != "" || len(actions) > 0
	summary := result.Text
	if summary == "" {
		if len(actions) > 0 {
			summary = "已生成写入提案，请主助手执行或确认。"
		} else {
			summary = "写子代理未产出方案"
		}
	}
	out := map[string]any{
		"ok": ok, "summary": summary, "proposedActions": actions,
		"usage": map[string]any{"calls": result.ToolCalls, "totalTokens": 0},
		"steps": result.Steps,
	}
	if !ok {
		out["errorCode"] = "empty_write_plan"
	}
	return out, nil
}

func sanitizeResearchDomains(domains []string) []AgentDomainId {
	allowed := map[AgentDomainId]struct{}{DomainKnowledge: {}, DomainSystem: {}}
	out := make([]AgentDomainId, 0, len(domains))
	seen := map[AgentDomainId]struct{}{}
	for _, raw := range domains {
		d := AgentDomainId(raw)
		if _, ok := allowed[d]; !ok {
			continue
		}
		if _, ok := seen[d]; ok {
			continue
		}
		seen[d] = struct{}{}
		out = append(out, d)
	}
	if len(out) == 0 {
		return []AgentDomainId{DomainKnowledge, DomainSystem}
	}
	return out
}

func filterSubagentToolNames(names []string, allowRespawn bool) []string {
	out := make([]string, 0, len(names))
	for _, name := range names {
		if name == spawnResearchSubagentName {
			if allowRespawn {
				out = append(out, name)
			}
			continue
		}
		if _, blocked := blockedSubagentTools[name]; blocked {
			continue
		}
		out = append(out, name)
	}
	return out
}

func filterWriteSubagentToolNames(names []string) []string {
	out := make([]string, 0, len(names))
	for _, name := range names {
		if _, blocked := blockedWriteSubagentTools[name]; blocked {
			continue
		}
		out = append(out, name)
	}
	return out
}

func normalizeProposedWriteActions(actions []proposedWriteAction) []proposedWriteAction {
	if len(actions) == 0 {
		return nil
	}
	out := make([]proposedWriteAction, 0, len(actions))
	seen := map[string]struct{}{}
	for _, a := range actions {
		risk, ok := writeProposalToolRisk[a.ToolName]
		if !ok {
			continue
		}
		key := a.ToolName + ":" + fmt.Sprint(a.Input)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		item := proposedWriteAction{ToolName: a.ToolName, Input: a.Input, Risk: risk}
		if strings.TrimSpace(a.Reason) != "" {
			item.Reason = strings.TrimSpace(a.Reason)
		}
		out = append(out, item)
		if len(out) >= 8 {
			break
		}
	}
	return out
}

func resolveSpawnDepthPolicy(ctx context.Context, depthIn, maxDepthIn *int) (depth, maxDepth int) {
	maxDepth = subagentDefaultMaxDepth
	if maxDepthIn != nil {
		maxDepth = *maxDepthIn
	} else if d := spawnMaxDepthFrom(ctx); d > 0 {
		maxDepth = d
	}
	if maxDepth > subagentAbsoluteMaxDepth {
		maxDepth = subagentAbsoluteMaxDepth
	}
	if maxDepth < 0 {
		maxDepth = 0
	}
	if depthIn != nil {
		depth = *depthIn
	} else if cur, ok := spawnDepthFrom(ctx); ok {
		depth = cur + 1
	} else {
		depth = 0
	}
	return depth, maxDepth
}

func buildResearchSubagentInstructions(goal string, depth, maxDepth int) string {
	lines := []string{
		"你是 Petrichor 站内只读研究子代理。只通过工具检索与阅读，汇总给主助手。",
		"禁止声称已写入、删除或改配置；没有的工具不要假装调用。",
		"优先 search → read；最终用中文给出简洁结论，并尽量调用 show_citations（href 必须来自工具结果）。",
		"本轮目标：" + goal,
		fmt.Sprintf("委派深度：depth=%d，maxDepth=%d。", depth, maxDepth),
	}
	if depth < maxDepth {
		lines = append(lines, "若目标可再拆成独立只读子任务，可再次调用 spawn_research_subagent；不要无意义嵌套。")
	} else {
		lines = append(lines, "已达再委派上限，不要尝试再次 spawn_research_subagent。")
	}
	return strings.Join(lines, "\n")
}

func buildWriteSubagentInstructions(goal string, seed []proposedWriteAction) string {
	lines := []string{
		"你是 Petrichor 站内「写意图」研究子代理：只读检索，规划写入方案，不直接改数据。",
		"禁止声称已创建/更新/删除/分享；没有写入工具，不要假装调用。",
		"用 search/read 核实目标后，必须调用 propose_write_actions 提交拟执行操作。",
		"最终用中文给出简洁方案说明。",
		"本轮目标：" + goal,
	}
	if len(seed) > 0 {
		lines = append(lines, fmt.Sprintf("主助手预置提案（可修订后通过 propose_write_actions 提交）：%v", seed))
	}
	return strings.Join(lines, "\n")
}

type proposalBucket struct {
	actions []proposedWriteAction
}

type ctxKeyProposalBucket struct{}

func proposalBucketFrom(ctx context.Context) *proposalBucket {
	v, _ := ctx.Value(ctxKeyProposalBucket{}).(*proposalBucket)
	return v
}

func runtimeFrom(ctx context.Context) *Runtime {
	v, _ := ctx.Value(ctxKeyRuntime{}).(*Runtime)
	return v
}
