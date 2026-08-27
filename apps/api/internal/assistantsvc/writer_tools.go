package assistantsvc

import (
	"encoding/json"
	"fmt"
	"strings"

	"petrichor/api/internal/aicore"
	rt "petrichor/api/internal/assistantsvc/runtime"
)

const (
	writerComposeSchema   = `{"type":"object","properties":{"topic":{"type":"string","minLength":1,"maxLength":300},"outline":{"type":"array","maxItems":20,"items":{"type":"string","minLength":1,"maxLength":200}},"audience":{"type":"string","maxLength":120},"style":{"type":"string","maxLength":120},"lengthHint":{"type":"string","enum":["short","medium","long"]}},"required":["topic"]}`
	writerRewriteSchema   = `{"type":"object","properties":{"text":{"type":"string","minLength":1,"maxLength":20000},"instruction":{"type":"string","minLength":1,"maxLength":500}},"required":["text","instruction"]}`
	writerSummarizeSchema = `{"type":"object","properties":{"text":{"type":"string","maxLength":30000},"focus":{"type":"string","maxLength":200},"maxPoints":{"type":"integer","minimum":1,"maximum":15}}}`
	writerStructureSchema = `{"type":"object","properties":{"topic":{"type":"string","minLength":1,"maxLength":300},"depth":{"type":"integer","minimum":1,"maximum":3}},"required":["topic"]}`
	writerArtifactSchema  = `{"type":"object","properties":{"artifactType":{"type":"string","enum":["answer","table","timeline","report","notes"]},"title":{"type":"string","minLength":1,"maxLength":200},"contentMd":{"type":"string","maxLength":100000},"payload":{}},"required":["title"]}`
)

const writerSystemPrompt = `你是写作助手，只负责生成正文，不做检索、不调用工具、不解释你的过程。

硬性要求：
- 正文中的事实必须来自给定证据；引用某条证据时在句末标注 [n]。
- 证据没覆盖的内容不要编造，需要时直接写明「资料未覆盖」。
- 直接输出成品正文，不要写“好的”“以下是”这类开场白。
- 使用 Markdown，标题层级从 ## 开始。`

func registerWriterTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "writer.compose", Name: "writer_compose", Namespace: rt.NamespaceWriter,
		Description: "基于本轮证据撰写长篇 Markdown；资料未查够时不要调用。",
		InputSchema: schemaJSON(writerComposeSchema), RiskLevel: rt.RiskLow, TimeoutMs: 90_000,
		Execute: executeWriterCompose, Normalize: writerNormalizer("撰写"),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "writer.rewrite", Name: "writer_rewrite", Namespace: rt.NamespaceWriter,
		Description: "按明确要求改写已有文本，保留原文事实与既有引用。",
		InputSchema: schemaJSON(writerRewriteSchema), RiskLevel: rt.RiskLow, TimeoutMs: 60_000,
		Execute: executeWriterRewrite, Normalize: writerNormalizer("改写"),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "writer.summarize", Name: "writer_summarize", Namespace: rt.NamespaceWriter,
		Description: "归纳指定文本；不传 text 时归纳本轮已收集证据。",
		InputSchema: schemaJSON(writerSummarizeSchema), RiskLevel: rt.RiskLow, TimeoutMs: 60_000,
		Execute: executeWriterSummarize, Normalize: writerNormalizer("归纳"),
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "writer.structure", Name: "writer_structure", Namespace: rt.NamespaceWriter,
		Description: "为主题生成由现有证据支撑的分层 Markdown 提纲。",
		InputSchema: schemaJSON(writerStructureSchema), RiskLevel: rt.RiskLow, TimeoutMs: 45_000,
		Execute: executeWriterStructure, Normalize: normalizeWriterStructure,
	})
	registry.Register(&rt.AgentToolDefinition{
		ID: "writer.save_artifact", Name: "save_answer_artifact", Namespace: rt.NamespaceWriter,
		Description: "仅在用户明确要求时，把回答、表格、时间线、报告或笔记保存为对话产物。",
		InputSchema: schemaJSON(writerArtifactSchema), RiskLevel: rt.RiskMedium, SideEffect: true,
		AllowedInSubAgent: toolPtr(false), Permissions: []string{rt.PermissionWrite},
		Execute: executeWriterSaveArtifact,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "写作产物已保存", Data: mustJSON(output), Progress: boolPtr(true)}
		},
	})
}

func writerGenerate(ctx *rt.ToolExecutionContext, systemPrompt, message string) (string, error) {
	resolved, err := aicore.ResolveModelForPurpose(toolContext(ctx), ctx.UserID, aicore.PurposeChat, nil)
	if err != nil {
		return "", err
	}
	result, err := aicore.Chat(toolContext(ctx), resolved.Runtime, resolved.ModelRef, []aicore.ChatMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: message},
	}, resolved.Options)
	if err != nil {
		return "", err
	}
	if ctx.RecordTokenUsage != nil {
		ctx.RecordTokenUsage(result.InputTokens, result.OutputTokens)
	}
	return strings.TrimSpace(result.Answer), nil
}

func renderWriterEvidenceBase(evidence []rt.AgentEvidence, limit int) string {
	if len(evidence) == 0 {
		return "（本轮没有收集到证据，只能写通用内容，必须显式说明缺少依据。）"
	}
	if limit <= 0 || limit > len(evidence) {
		limit = len(evidence)
	}
	blocks := make([]string, 0, limit)
	for index, item := range evidence[:limit] {
		source := item.URL
		if source == "" {
			source = string(item.Source)
			switch path := item.Metadata["path"].(type) {
			case []string:
				if len(path) > 0 {
					source = strings.Join(path, " / ")
				}
			case []any:
				segments := []string{}
				for _, value := range path {
					if text, ok := value.(string); ok {
						segments = append(segments, text)
					}
				}
				if len(segments) > 0 {
					source = strings.Join(segments, " / ")
				}
			}
		}
		title := item.Title
		if title == "" {
			title = "未命名"
		}
		blocks = append(blocks, fmt.Sprintf("[%d] %s（%s）\n%s", index+1, title, source, truncateRunes(item.Content, 1200)))
	}
	return strings.Join(blocks, "\n\n")
}

func executeWriterCompose(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	lengthGuidance := map[string]string{
		"short": "控制在 400 字以内", "medium": "控制在 800~1500 字", "long": "可以写到 2000 字以上，但不要注水",
	}[stringValue(params["lengthHint"])]
	if lengthGuidance == "" {
		lengthGuidance = "控制在 800~1500 字"
	}
	constraints := []string{lengthGuidance}
	if audience := strings.TrimSpace(stringValue(params["audience"])); audience != "" {
		constraints = append(constraints, "读者："+audience)
	}
	if style := strings.TrimSpace(stringValue(params["style"])); style != "" {
		constraints = append(constraints, "风格："+style)
	}
	outline := stringSliceValue(params["outline"])
	if len(outline) > 0 {
		lines := []string{"按以下提纲组织："}
		for index, item := range outline {
			lines = append(lines, fmt.Sprintf("%d. %s", index+1, item))
		}
		constraints = append(constraints, strings.Join(lines, "\n"))
	}
	evidence := []rt.AgentEvidence{}
	if ctx.State != nil {
		evidence = ctx.State.Evidence
	}
	text, err := writerGenerate(ctx, writerSystemPrompt,
		"主题："+strings.TrimSpace(stringValue(params["topic"]))+"\n\n"+strings.Join(constraints, "\n")+"\n\n可用证据：\n"+renderWriterEvidenceBase(evidence, 12))
	if err != nil {
		return nil, err
	}
	return map[string]any{"text": text, "chars": len([]rune(text)), "evidenceUsed": minInt(len(evidence), 12)}, nil
}

func executeWriterRewrite(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	text, err := writerGenerate(ctx,
		writerSystemPrompt+"\n\n本次任务是改写：保留原文事实与既有 [n] 引用，只按要求调整表达与结构。",
		"改写要求："+strings.TrimSpace(stringValue(params["instruction"]))+"\n\n原文：\n"+stringValue(params["text"]))
	if err != nil {
		return nil, err
	}
	return map[string]any{"text": text, "chars": len([]rune(text))}, nil
}

func executeWriterSummarize(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	source := strings.TrimSpace(stringValue(params["text"]))
	fromEvidence := source == ""
	if fromEvidence {
		evidence := []rt.AgentEvidence{}
		if ctx.State != nil {
			evidence = ctx.State.Evidence
		}
		source = renderWriterEvidenceBase(evidence, 20)
	}
	maxPoints := intValue(params["maxPoints"])
	if maxPoints <= 0 || maxPoints > 15 {
		maxPoints = 8
	}
	message := ""
	if focus := strings.TrimSpace(stringValue(params["focus"])); focus != "" {
		message = "侧重：" + focus + "\n\n"
	}
	message += "材料：\n" + source
	text, err := writerGenerate(ctx,
		fmt.Sprintf("%s\n\n本次任务是归纳：输出 Markdown 无序列表，每条一个要点，最多 %d 条。", writerSystemPrompt, maxPoints), message)
	if err != nil {
		return nil, err
	}
	return map[string]any{"text": text, "chars": len([]rune(text)), "fromEvidence": fromEvidence}, nil
}

func executeWriterStructure(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	depth := intValue(params["depth"])
	if depth <= 0 || depth > 3 {
		depth = 2
	}
	evidence := []rt.AgentEvidence{}
	if ctx.State != nil {
		evidence = ctx.State.Evidence
	}
	text, err := writerGenerate(ctx,
		fmt.Sprintf("%s\n\n本次任务只输出提纲：%d 级 Markdown 列表，不要写正文。", writerSystemPrompt, depth),
		"主题："+strings.TrimSpace(stringValue(params["topic"]))+"\n\n已有证据（提纲要能被这些证据支撑）：\n"+renderWriterEvidenceBase(evidence, 10))
	if err != nil {
		return nil, err
	}
	return map[string]any{"text": text, "chars": len([]rune(text))}, nil
}

func executeWriterSaveArtifact(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	kind := stringValue(params["artifactType"])
	if kind == "" {
		kind = "answer"
	}
	contentJSON, err := json.Marshal(map[string]any{"contentMd": params["contentMd"], "payload": params["payload"]})
	if err != nil {
		return nil, rt.ValidationError("产物内容无法序列化")
	}
	threadID := parseID(ctx.ConversationID)
	if threadID <= 0 {
		return nil, rt.ValidationError("缺少有效对话 id")
	}
	var id int64
	err = dbPool().QueryRow(toolContext(ctx), `
		INSERT INTO petrichor_assistant_artifact (thread_id,run_id,kind,title,content_json,created_at)
		SELECT $1, NULLIF($2,0), $3, $4, $5, now()
		WHERE EXISTS (SELECT 1 FROM petrichor_assistant_thread WHERE id=$1 AND user_id=$6 AND deleted_at IS NULL)
		RETURNING id`, threadID, ctx.DBRunID, kind, strings.TrimSpace(stringValue(params["title"])), string(contentJSON), ctx.UserID).Scan(&id)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": idStr(id), "artifactType": kind, "title": strings.TrimSpace(stringValue(params["title"]))}, nil
}

func writerNormalizer(kind string) rt.ToolNormalizer {
	return func(output any, _ any) rt.ToolNormalizerResult {
		record, _ := output.(map[string]any)
		text, _ := record["text"].(string)
		if strings.TrimSpace(text) == "" {
			return rt.ToolNormalizerResult{Summary: kind + "未产出内容", SuggestedActions: []string{"retry", "reduce_scope"}, Progress: boolPtr(false)}
		}
		return rt.ToolNormalizerResult{Summary: fmt.Sprintf("%s完成（%d 字）", kind, len([]rune(text))), Data: mustJSON(map[string]any{"text": text}), Progress: boolPtr(true)}
	}
}

func normalizeWriterStructure(output any, _ any) rt.ToolNormalizerResult {
	record, _ := output.(map[string]any)
	text, _ := record["text"].(string)
	items := 0
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "-") || strings.HasPrefix(trimmed, "*") || (len(trimmed) > 1 && trimmed[0] >= '0' && trimmed[0] <= '9') {
			items++
		}
	}
	summary := "提纲未产出内容"
	actions := []string{}
	if items > 0 {
		summary = fmt.Sprintf("提纲已生成（%d 个条目）", items)
		actions = []string{"writer.compose"}
	}
	return rt.ToolNormalizerResult{Summary: summary, Data: mustJSON(map[string]any{"outline": text}), SuggestedActions: actions, Progress: boolPtr(items > 0)}
}
