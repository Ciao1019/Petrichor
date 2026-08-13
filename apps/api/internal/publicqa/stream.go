package publicqa

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"

	"github.com/cloudwego/eino/callbacks"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/flow/agent"
	"github.com/cloudwego/eino/flow/agent/react"
	"github.com/cloudwego/eino/schema"
	callbacksTemplate "github.com/cloudwego/eino/utils/callbacks"
	"github.com/google/uuid"

	"github.com/Ciao1019/Petrichor/apps/api/internal/http/uistream"
)

type publicUIMessage struct {
	Role    string                `json:"role"`
	Content any                   `json:"content"`
	Parts   []publicUIMessagePart `json:"parts"`
}

type publicUIMessagePart struct {
	Type           string         `json:"type"`
	Text           string         `json:"text"`
	ToolName       string         `json:"toolName"`
	Input          any            `json:"input"`
	Args           any            `json:"args"`
	Output         any            `json:"output"`
	Result         any            `json:"result"`
	ToolInvocation map[string]any `json:"toolInvocation"`
}

func publicMessagesForModel(messages []publicUIMessage) []*schema.Message {
	out := make([]*schema.Message, 0, len(messages))
	for _, message := range messages {
		text := publicMessageText(message)
		if text == "" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(message.Role)) {
		case "user":
			out = append(out, schema.UserMessage(text))
		case "assistant":
			out = append(out, schema.AssistantMessage(text, nil))
		}
	}
	return out
}

func publicMessageText(message publicUIMessage) string {
	parts := make([]string, 0, len(message.Parts)+1)
	for _, part := range message.Parts {
		if part.Type == "text" && strings.TrimSpace(part.Text) != "" {
			parts = append(parts, strings.TrimSpace(part.Text))
		}
	}
	if len(parts) == 0 {
		if text, ok := message.Content.(string); ok && strings.TrimSpace(text) != "" {
			parts = append(parts, strings.TrimSpace(text))
		}
	}
	for _, part := range message.Parts {
		name := publicPartToolName(part)
		if name == "" {
			continue
		}
		output := publicPartOutput(part)
		if output == nil {
			continue
		}
		if raw, err := json.Marshal(output); err == nil {
			parts = append(parts, "[工具 "+name+" 的历史结果] "+string(raw))
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func publicPartToolName(part publicUIMessagePart) string {
	if strings.TrimSpace(part.ToolName) != "" {
		return strings.TrimSpace(part.ToolName)
	}
	if strings.HasPrefix(part.Type, "tool-") && part.Type != "tool-call" && part.Type != "tool-invocation" {
		return strings.TrimSpace(strings.TrimPrefix(part.Type, "tool-"))
	}
	if part.ToolInvocation != nil {
		if name, _ := part.ToolInvocation["toolName"].(string); strings.TrimSpace(name) != "" {
			return strings.TrimSpace(name)
		}
	}
	return ""
}

func publicPartOutput(part publicUIMessagePart) any {
	if part.Output != nil {
		return part.Output
	}
	if part.Result != nil {
		return part.Result
	}
	if part.ToolInvocation != nil {
		if value := part.ToolInvocation["output"]; value != nil {
			return value
		}
		return part.ToolInvocation["result"]
	}
	return nil
}

type publicToolAudit struct {
	ID   string
	Name string
}

type publicToolAuditKey struct{}

func (h *Handler) streamAnswer(
	ctx context.Context,
	chatModel model.ToolCallingChatModel,
	messages []*schema.Message,
	scope publicArticleScope,
	w *uistream.Writer,
) error {
	tools := h.buildPublicQATools(scope)
	callback := react.BuildAgentCallback(&callbacksTemplate.ModelCallbackHandler{}, &callbacksTemplate.ToolCallbackHandler{
		OnStart: func(ctx context.Context, info *callbacks.RunInfo, input *tool.CallbackInput) context.Context {
			audit := publicToolAudit{ID: "call_" + uuid.NewString(), Name: publicToolName(info)}
			arguments := any(map[string]any{})
			if input != nil {
				arguments = parsePublicToolJSON(input.ArgumentsInJSON)
			}
			w.ToolInputStart(audit.ID, audit.Name)
			if raw, err := json.Marshal(arguments); err == nil {
				w.ToolInputDelta(audit.ID, string(raw))
			}
			w.ToolInputAvailable(audit.ID, audit.Name, arguments)
			return context.WithValue(ctx, publicToolAuditKey{}, audit)
		},
		OnEnd: func(ctx context.Context, info *callbacks.RunInfo, output *tool.CallbackOutput) context.Context {
			audit := publicToolAuditFromContext(ctx, info)
			value := any(map[string]any{})
			if output != nil {
				value = parsePublicToolJSON(output.Response)
			}
			w.ToolOutputAvailable(audit.ID, value)
			return ctx
		},
		OnError: func(ctx context.Context, info *callbacks.RunInfo, toolErr error) context.Context {
			audit := publicToolAuditFromContext(ctx, info)
			message := "工具执行失败"
			if toolErr != nil && strings.TrimSpace(toolErr.Error()) != "" {
				message = toolErr.Error()
			}
			w.ToolOutputError(audit.ID, message)
			return ctx
		},
	})
	agentInstance, err := react.NewAgent(ctx, &react.AgentConfig{
		ToolCallingModel: chatModel,
		ToolsConfig:      compose.ToolsNodeConfig{Tools: tools},
		MaxStep:          publicQAMaxSteps,
		MessageModifier:  react.NewPersonaModifier(buildPublicQASystemPrompt()),
	})
	if err != nil {
		return err
	}
	stream, err := agentInstance.Stream(ctx, messages, agent.WithComposeOptions(compose.WithCallbacks(callback)))
	if err != nil {
		return err
	}
	defer stream.Close()
	for {
		message, receiveErr := stream.Recv()
		if errors.Is(receiveErr, io.EOF) {
			return nil
		}
		if receiveErr != nil {
			return receiveErr
		}
		if message != nil && message.Content != "" {
			w.TextDelta(message.Content)
		}
	}
}

func parsePublicToolJSON(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	var parsed any
	if json.Unmarshal([]byte(raw), &parsed) == nil {
		return parsed
	}
	return raw
}

func publicToolName(info *callbacks.RunInfo) string {
	if info == nil || strings.TrimSpace(info.Name) == "" {
		return "unknown_tool"
	}
	return info.Name
}

func publicToolAuditFromContext(ctx context.Context, info *callbacks.RunInfo) publicToolAudit {
	if audit, ok := ctx.Value(publicToolAuditKey{}).(publicToolAudit); ok {
		return audit
	}
	return publicToolAudit{ID: "call_" + uuid.NewString(), Name: publicToolName(info)}
}

func buildPublicQASystemPrompt() string {
	return strings.Join([]string{
		"你是本站的公开文档问答助手，面向未登录的访客。你的知识范围严格限定在本站公开分享的文章之内。",
		"核心规则：",
		"1. 自我介绍、能力说明、寒暄等元问题直接简短回答，不调用检索或 UI 工具。",
		"2. 问公开文章列表时调用 list_public_articles；可用 show_data_table 整理清单。",
		"3. 回答具体内容前先用 search_public_articles 定位文章；摘要片段不足时用 read_source_article 读取公开原文。",
		"4. 公开问答只面向公开文章，不读取私有知识库文件、文件 Wiki 或内部检索结构。",
		"5. 严禁编造或使用公开文章之外的知识；检索不到时如实回答本站暂无相关公开资料。",
		"6. 回答必须调用 show_citations 给出依据，href 使用 /p/<shareCode>，title 使用文章标题。",
		"7. show_agent_plan / show_progress 只用于真实多步任务；对比、清单和矩阵用 show_data_table。",
		"8. 展示媒体时使用读取工具返回的 media：image 用 Markdown 图片；video/audio/file 使用自闭合标签并独立成段。",
		"9. 只使用中文回答。答案直接、结构清晰、避免编造。",
	}, "\n")
}
