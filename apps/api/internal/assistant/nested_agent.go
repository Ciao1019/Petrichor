package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/flow/agent/react"
	"github.com/cloudwego/eino/schema"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantstep"
)

const (
	subagentMaxSteps         = 6
	subagentTimeout          = 90 * time.Second
	subagentDefaultMaxDepth  = 1
	subagentAbsoluteMaxDepth = 2
)

type nestedAgentStepSummary struct {
	ToolName  string  `json:"toolName"`
	OK        bool    `json:"ok"`
	ErrorCode *string `json:"errorCode,omitempty"`
}

type nestedAgentResult struct {
	Text      string
	ToolCalls int
	Steps     []nestedAgentStepSummary
}

type nestedAgentOptions struct {
	Runtime         *Runtime
	UserID          int64
	ThreadID        int64
	RunID           int64
	SystemRole      string
	Focus           *AssistantFocus
	ModelCfg        *ent.AIModelConfig
	AgentName       string
	Instructions    string
	Domains         []AgentDomainId
	FilterToolNames func([]string) []string
	AugmentTools    []tool.BaseTool
	Prompt          string
	MaxSteps        int
	Timeout         time.Duration
	StepPrefix      string
	SpawnDepth      int
	SpawnMaxDepth   int
}

func runNestedAgentGenerate(ctx context.Context, opt nestedAgentOptions) (nestedAgentResult, error) {
	if opt.Runtime == nil {
		return nestedAgentResult{}, fmt.Errorf("缺少 Runtime")
	}
	if opt.ModelCfg == nil {
		cfg, err := opt.Runtime.resolveChatModelConfig(ctx, opt.UserID, nil)
		if err != nil {
			return nestedAgentResult{}, err
		}
		opt.ModelCfg = cfg
	}
	chatModel, err := opt.Runtime.buildChatModel(ctx, opt.ModelCfg)
	if err != nil {
		return nestedAgentResult{}, err
	}
	maxSteps := opt.MaxSteps
	if maxSteps <= 0 {
		maxSteps = subagentMaxSteps
	}
	timeout := opt.Timeout
	if timeout <= 0 {
		timeout = subagentTimeout
	}

	allNames := listToolNamesForDomains(opt.Domains, isOperator(opt.SystemRole))
	if opt.FilterToolNames != nil {
		allNames = opt.FilterToolNames(allNames)
	}
	wanted := map[string]struct{}{}
	for _, name := range allNames {
		wanted[name] = struct{}{}
	}
	tools := make([]tool.BaseTool, 0, len(wanted)+len(opt.AugmentTools))
	for name, reg := range toolRegistry {
		if _, ok := wanted[name]; !ok {
			continue
		}
		if reg.Risk == RiskDangerous {
			continue
		}
		if reg.RequiresOperator && !isOperator(opt.SystemRole) {
			continue
		}
		tools = append(tools, reg.Factory())
	}
	tools = append(tools, opt.AugmentTools...)

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	toolCtx := withToolContext(runCtx, ToolContext{
		UserID:     opt.UserID,
		ThreadID:   opt.ThreadID,
		RunID:      opt.RunID,
		Focus:      opt.Focus,
		SystemRole: opt.SystemRole,
		SpawnDepth: &opt.SpawnDepth,
	}, opt.Runtime.client, opt.Runtime.cfg)
	toolCtx = context.WithValue(toolCtx, ctxKeyRuntime{}, opt.Runtime)
	toolCtx = context.WithValue(toolCtx, ctxKeySpawnMaxDepth{}, opt.SpawnMaxDepth)

	agentInst, err := react.NewAgent(runCtx, &react.AgentConfig{
		ToolCallingModel: chatModel,
		ToolsConfig:      compose.ToolsNodeConfig{Tools: tools},
		MaxStep:          maxSteps,
		MessageModifier:  react.NewPersonaModifier(opt.Instructions),
	})
	if err != nil {
		return nestedAgentResult{}, err
	}

	msg, err := agentInst.Generate(toolCtx, []*schema.Message{schema.UserMessage(opt.Prompt)})
	if err != nil {
		if runCtx.Err() != nil {
			return nestedAgentResult{}, fmt.Errorf("subagent_timeout")
		}
		return nestedAgentResult{}, err
	}

	text := ""
	if msg != nil {
		text = strings.TrimSpace(msg.Content)
	}
	steps := loadNestedSteps(runCtx, opt.Runtime.client, opt.RunID, opt.StepPrefix)
	return nestedAgentResult{
		Text:      text,
		ToolCalls: len(steps),
		Steps:     steps,
	}, nil
}

func loadNestedSteps(ctx context.Context, client *ent.Client, runID int64, prefix string) []nestedAgentStepSummary {
	if runID <= 0 || client == nil {
		return nil
	}
	rows, err := client.AssistantStep.Query().
		Where(assistantstep.RunIDEQ(runID)).
		Order(ent.Desc(assistantstep.FieldStepIndex)).
		Limit(20).
		All(ctx)
	if err != nil {
		return nil
	}
	out := make([]nestedAgentStepSummary, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		row := rows[i]
		if prefix != "" && !strings.HasPrefix(row.ToolName, prefix) && !strings.Contains(row.ToolName, "/") {
			// 主代理步骤混入时，尽量只展示本轮前后的工具名摘要
		}
		ok := row.Status == "COMPLETED"
		var code *string
		if row.ErrorCode != nil && strings.TrimSpace(*row.ErrorCode) != "" {
			code = row.ErrorCode
			ok = false
		}
		out = append(out, nestedAgentStepSummary{ToolName: row.ToolName, OK: ok, ErrorCode: code})
	}
	return out
}

func recordNestedStep(ctx context.Context, client *ent.Client, runID int64, stepPrefix, toolName string, output any, ok bool, errCode string) {
	if runID <= 0 || client == nil {
		return
	}
	count, _ := client.AssistantStep.Query().Where(assistantstep.RunIDEQ(runID)).Count(ctx)
	raw, _ := json.Marshal(output)
	status := "COMPLETED"
	if !ok {
		status = "FAILED"
	}
	name := toolName
	if stepPrefix != "" {
		name = stepPrefix + "/" + toolName
	}
	builder := client.AssistantStep.Create().
		SetRunID(runID).
		SetStepIndex(count).
		SetToolName(name).
		SetOutputJSON(string(raw)).
		SetStatus(status)
	if errCode != "" {
		builder = builder.SetErrorCode(errCode)
	}
	_, _ = builder.Save(ctx)
}

type ctxKeySpawnMaxDepth struct{}

func spawnMaxDepthFrom(ctx context.Context) int {
	v, _ := ctx.Value(ctxKeySpawnMaxDepth{}).(int)
	if v <= 0 {
		return subagentDefaultMaxDepth
	}
	return v
}
