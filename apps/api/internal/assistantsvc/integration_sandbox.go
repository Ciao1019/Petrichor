package assistantsvc

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"petrichor/api/internal/agentsandbox"
	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/config"
)

func registerSandboxTools(registry interface{ Register(*rt.AgentToolDefinition) }, skills interface{ Register(rt.AgentSkill) }) {
	registry.Register(&rt.AgentToolDefinition{ID: "sandbox.execute", Name: "execute_sandbox_code", Namespace: rt.NamespaceAgent,
		Description: "在无网络、无宿主文件的临时沙箱运行 Python/JavaScript 计算；输入数据放入代码，结果用 stdout 输出。",
		InputSchema: schemaJSON(`{"type":"object","additionalProperties":false,"properties":{"language":{"type":"string","enum":["python","javascript"]},"code":{"type":"string","minLength":1,"maxLength":16000}},"required":["language","code"]}`),
		RiskLevel:   rt.RiskMedium, TimeoutMs: 70000, MaxRetries: -1, AllowedInSubAgent: toolPtr(false), Execute: executeSandboxCode, Normalize: normalizeExternalOutput})
	skills.Register(rt.AgentSkill{ID: "computation", Name: "代码计算", Description: "用隔离 Python/JavaScript 处理数据、计算和验证结果。",
		Instructions: "调用 execute_sandbox_code。仅支持 Python 标准库、JavaScript 内置模块，无网络、无宿主文件；单次执行最多 60 秒，内存 256 MiB。代码和数据通过本次请求输入，用 print/console.log 输出。不要假设上次执行的文件仍在。检查 exitCode，失败时如实说明。", ToolIDs: []string{"sandbox.execute"}})
}

func executeSandboxCode(execCtx *rt.ToolExecutionContext, input any) (any, error) {
	cfg := config.Get().Agent.Integrations.Sandbox
	if !cfg.Enabled {
		return nil, rt.ValidationError("代码沙箱尚未配置")
	}
	if !cfg.AllowUsers && !rt.IsAssistantOperator(execCtx.SystemRole) {
		return nil, rt.PermissionDenied("代码沙箱仅限操作员")
	}
	ctx, cancel := context.WithTimeout(toolContext(execCtx), time.Duration(cfg.TimeoutSeconds+5)*time.Second)
	defer cancel()
	body, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.URL, bytes.NewReader(body))
	if err != nil {
		return nil, rt.ValidationError("沙箱地址无效")
	}
	request.Header.Set("Authorization", "Bearer "+cfg.Token)
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return nil, rt.ValidationError("沙箱连接失败或执行超时")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, rt.ValidationError("沙箱执行失败，请检查服务或代码运行时限")
	}
	var result agentsandbox.Result
	data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 || json.Unmarshal(data, &result) != nil {
		return nil, rt.ValidationError("沙箱返回无效结果")
	}
	return result, nil
}
