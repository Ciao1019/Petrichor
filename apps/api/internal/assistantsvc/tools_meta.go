package assistantsvc

import (
	"encoding/json"
	"fmt"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func registerAgentMetaTools(registry interface {
	Register(tool *rt.AgentToolDefinition)
}) {
	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.load_skill", Name: "load_skill", Namespace: rt.NamespaceAgent,
		Description: "加载一个能力包（技能），获得对应工具集与操作说明。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"skill":{"type":"string","minLength":1,"maxLength":64,"enum":["knowledge","graph","research","memory","writer","documents","admin","system"]},"skillId":{"type":"string","minLength":1,"maxLength":64,"description":"兼容旧调用；优先使用 skill"}},"anyOf":[{"required":["skill"]},{"required":["skillId"]}]}`),
		RiskLevel:   rt.RiskLow, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeLoadSkill,
		Normalize: func(_ any, input any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "技能加载请求已完成", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.delegate", Name: "delegate_task", Namespace: rt.NamespaceAgent,
		Description: "把彼此独立的复杂子任务委派给最多 3 个并行子代理。简单问答或单次检索不要委派。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"tasks":{"type":"array","minItems":1,"maxItems":5,"items":{"type":"object","properties":{"objective":{"type":"string","minLength":1,"maxLength":2000},"context":{"type":"string","maxLength":4000},"skillIds":{"type":"array","maxItems":4,"items":{"type":"string","minLength":1}},"allowedToolIds":{"type":"array","maxItems":16,"items":{"type":"string","minLength":1}},"expectedOutput":{"type":"string","maxLength":500},"maxToolCalls":{"type":"integer","minimum":1,"maximum":12}},"required":["objective"]}}},"required":["tasks"]}`),
		RiskLevel:   rt.RiskMedium, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeDelegateTasks,
		Normalize: func(output any, _ any) rt.ToolNormalizerResult {
			payload, _ := output.(map[string]any)
			results, _ := payload["results"].([]map[string]any)
			done := 0
			for _, result := range results {
				if result["status"] == "completed" {
					done++
				}
			}
			normalized := rt.ToolNormalizerResult{
				Summary: fmt.Sprintf("委派 %d 个子任务，完成 %d 个", len(results), done),
				Data:    mustJSON(map[string]any{"results": results}),
			}
			if done < len(results) {
				normalized.SuggestedActions = []string{"handle_failed_subtask_inline"}
			}
			return normalized
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.list_skills", Name: "list_skills", Namespace: rt.NamespaceAgent,
		Description: "列出全部可加载的能力及加载状态。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`),
		RiskLevel:   rt.RiskLow, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeListSkills,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已列出可用能力目录", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.get_plan", Name: "get_plan", Namespace: rt.NamespaceAgent,
		Description: "查看当前任务计划与步骤状态。",
		InputSchema: schemaJSON(`{"type":"object","properties":{}}`),
		RiskLevel:   rt.RiskLow, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeGetPlan,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "已返回当前计划", Progress: boolPtr(false)}
		},
	})

	registry.Register(&rt.AgentToolDefinition{
		ID: "agent.update_plan", Name: "update_plan", Namespace: rt.NamespaceAgent,
		Description: "增删改查当前计划步骤（op: set/add/update/remove/reorder）。",
		InputSchema: schemaJSON(`{"type":"object","properties":{"ops":{"type":"array","minItems":1,"maxItems":10,"items":{"oneOf":[{"type":"object","properties":{"op":{"const":"set"},"steps":{"type":"array","minItems":1,"maxItems":12,"items":{"type":"object","properties":{"goal":{"type":"string","minLength":1,"maxLength":300},"dependsOn":{"type":"array","maxItems":8,"items":{"type":"string"}}},"required":["goal"]}}},"required":["op","steps"]},{"type":"object","properties":{"op":{"const":"add"},"goal":{"type":"string","minLength":1,"maxLength":300},"afterId":{"type":"string"},"dependsOn":{"type":"array","maxItems":8,"items":{"type":"string"}}},"required":["op","goal"]},{"type":"object","properties":{"op":{"const":"update"},"id":{"type":"string","minLength":1},"goal":{"type":"string","minLength":1,"maxLength":300},"status":{"type":"string","enum":["pending","running","completed","skipped","failed"]},"resultSummary":{"type":"string","maxLength":500}},"required":["op","id"]},{"type":"object","properties":{"op":{"const":"remove"},"id":{"type":"string","minLength":1}},"required":["op","id"]},{"type":"object","properties":{"op":{"const":"reorder"},"orderedIds":{"type":"array","minItems":2,"items":{"type":"string","minLength":1}}},"required":["op","orderedIds"]}]}}},"required":["ops"]}`),
		RiskLevel:   rt.RiskLow, Core: true, AllowedInSubAgent: toolPtr(false),
		Execute: executeUpdatePlan,
		Normalize: func(_ any, _ any) rt.ToolNormalizerResult {
			return rt.ToolNormalizerResult{Summary: "计划已更新", Progress: boolPtr(false)}
		},
	})
}

func executeLoadSkill(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	skillID, _ := params["skill"].(string)
	if skillID == "" {
		skillID, _ = params["skillId"].(string)
	}
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	result := ctx.Services.LoadSkill(skillID)
	payload, _ := json.Marshal(result)
	return json.RawMessage(payload), nil
}

func executeDelegateTasks(ctx *rt.ToolExecutionContext, input any) (any, error) {
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	params, _ := input.(map[string]any)
	rawTasks, _ := params["tasks"].([]any)
	tasks := make([]rt.DelegateTaskInput, 0, len(rawTasks))
	for _, rawTask := range rawTasks {
		taskMap, ok := rawTask.(map[string]any)
		if !ok {
			continue
		}
		task := rt.DelegateTaskInput{
			Objective:      stringValue(taskMap["objective"]),
			Context:        stringValue(taskMap["context"]),
			SkillIDs:       stringSliceValue(taskMap["skillIds"]),
			AllowedToolIDs: stringSliceValue(taskMap["allowedToolIds"]),
			ExpectedOutput: stringValue(taskMap["expectedOutput"]),
			MaxToolCalls:   intValue(taskMap["maxToolCalls"]),
		}
		tasks = append(tasks, task)
	}
	results := ctx.Services.Delegate(tasks)
	publicResults := make([]map[string]any, 0, len(results))
	ok := false
	for _, result := range results {
		if result.Status == "completed" {
			ok = true
		}
		publicResults = append(publicResults, map[string]any{
			"taskId": result.TaskID, "status": result.Status, "summary": result.Summary,
			"evidenceCount": len(result.Evidence),
		})
	}
	return map[string]any{"ok": ok, "results": publicResults}, nil
}

func executeListSkills(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	return map[string]any{"skills": ctx.Services.ListSkills()}, nil
}

func executeGetPlan(ctx *rt.ToolExecutionContext, _ any) (any, error) {
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	return map[string]any{"plan": ctx.Services.GetPlan()}, nil
}

func executeUpdatePlan(ctx *rt.ToolExecutionContext, input any) (any, error) {
	params, _ := input.(map[string]any)
	opsRaw, _ := params["ops"].([]any)
	ops := make([]rt.PlanUpdateOp, 0, len(opsRaw))
	for _, rawOp := range opsRaw {
		opMap, ok := rawOp.(map[string]any)
		if !ok {
			continue
		}
		op := rt.PlanUpdateOp{}
		op.Op, _ = opMap["op"].(string)
		op.Goal, _ = opMap["goal"].(string)
		op.ID, _ = opMap["id"].(string)
		op.Summary, _ = opMap["resultSummary"].(string)
		op.DependsOn = stringSliceValue(opMap["dependsOn"])
		op.OrderedID = stringSliceValue(opMap["orderedIds"])
		if status, ok := opMap["status"].(string); ok {
			op.Status = rt.AgentPlanStepStatus(status)
		}
		if afterID, ok := opMap["afterId"].(string); ok {
			op.AfterID = afterID
		}
		if steps, ok := opMap["steps"].([]any); ok {
			for _, s := range steps {
				stepMap, ok := s.(map[string]any)
				if !ok {
					continue
				}
				goal, _ := stepMap["goal"].(string)
				op.Steps = append(op.Steps, rt.PlanStepDraft{
					Goal: goal, DependsOn: stringSliceValue(stepMap["dependsOn"]),
				})
			}
		}
		ops = append(ops, op)
	}
	if ctx.Services == nil {
		return nil, rt.PermissionDenied("服务面不可用")
	}
	plan := ctx.Services.UpdatePlan(ops)
	return map[string]any{"plan": plan}, nil
}

// ===== 内置技能 =====

func registerBuiltinSkills(skills interface{ Register(skill rt.AgentSkill) }) {
	skills.Register(rt.AgentSkill{
		ID: "knowledge", Name: "知识库", Description: "检索并深读站内知识库内容",
		Instructions: joinStrings([]string{
			"## 知识库检索与阅读",
			"1. 简单的定义、功能、用途、用法问题优先调用 knowledge.lookup；它会一次完成检索与最相关 1~2 个章节的深读，不要再重复调用 search/read。",
			"2. 复杂比较、跨主题研究或需要自主挑选章节时，使用 knowledge.search 定位候选，再调用 knowledge.read_many 并行深读。",
			"3. knowledge.search 只返回候选（标题/路径/摘要/命中来源），不能当作正文证据。简单问题深读最相关的 1~2 个章节；多步/复杂问题按覆盖面深读 2~4 个。",
			"3.1 结构性问题（某文档里哪几章讲了什么、按章节顺序汇总、定位「第几节」）先用 knowledge.outline 拿整篇目录，再挑章节深读；相似度检索会打散文档结构，不适合这类问题。",
			"4. read 返回的层级上下文只用于理解章节位置；事实结论优先依据目标章节正文。",
			"5. 读完发现缺少某个概念或前置信息时，用新的查询词再检索一次，这是被鼓励的多轮检索。",
			"6. 复杂问题可以拆成多个子查询分别检索，系统会自动融合多路召回结果。",
			"7. 当前对话已锁定知识库时沿用该范围；用户明确要求跨库时不要传 knowledgeBaseId。",
			"8. 跨库检索命中的条目，回读时必须把该条目的 knowledgeBaseId 一起传回。",
			"9. 检索不到就如实说明知识库中没有，不要用常识补全内部实现细节。",
			"10. 证据里出现 [本章节可引用的媒体] 时，按 kind 输出对应标签，src 一律用原值（通常是 s4key:…）：image 用 ![说明](src)；video 用自闭合 <video src=\"src\" />；audio 用自闭合 <audio src=\"src\" />；file 用自闭合 <file src=\"src\" name=\"文件名\" />。",
		}, "\n"),
		ToolIDs: []string{"knowledge.lookup", "knowledge.search", "knowledge.outline",
			"knowledge.read_many", "knowledge.read", "knowledge.list_bases"},
		Tags: []string{"retrieval"},
	})

	skills.Register(rt.AgentSkill{
		ID: "documents", Name: "文档与内容管理", Description: "文档检索、阅读、文章创建更新、移动与分享",
		Instructions: joinStrings([]string{
			"## 文档操作",
			"1. document.search / document.read 用于检索与阅读文档库内容。",
			"2. create_article / update_article / move_article / create_article_share 只有在用户明确要求实际落库时才能调用，不要把讨论或草稿误当成执行授权。",
			"3. 大段修改文章正文前必须先 preview_article_update，把 diff 给用户审核；小范围、明确的改动可直接更新。",
			"4. update_article 是部分更新：只传需要变更的 title/contentMd，不要为了改标题覆盖正文。",
			"5. 删除、撤销必须调用 request_user_confirmation：删除文章用 action.toolName=delete_article；撤销分享用 revoke_article_share；删除文档库文档用 delete_document。禁止直接调用或假装已执行。",
		}, "\n"),
		ToolIDs: []string{
			"document.list_libraries", "document.search", "document.read", "document.export",
			"document.create", "document.update", "document.preview_update", "document.move", "document.share",
			"agent.request_confirmation",
		},
		Tags: []string{"document"},
	})

	skills.Register(rt.AgentSkill{
		ID: "research", Name: "外部研究", Description: "搜索与阅读站外公开资料",
		Instructions: joinStrings([]string{
			"## 外部资料研究",
			"1. research.search 拿候选来源，research.fetch 抓取正文，research.extract 提取要点。",
			"2. 不要只凭搜索摘要下重要结论：关键结论必须 fetch 原文后再判断。",
			"3. 涉及\"最新 / 当前 / 官方推荐\"的问题，优先官方文档与一手来源，并留意发布时间。",
			"4. 单个来源抓取失败不要放弃整个任务，换一个来源继续。",
		}, "\n"),
		ToolIDs: []string{"research.search", "research.fetch", "research.extract"},
		Tags:    []string{"external"},
	})

	skills.Register(rt.AgentSkill{
		ID: "memory", Name: "长期记忆", Description: "跨会话的长期记忆检索与维护",
		Instructions: joinStrings([]string{
			"## 长期记忆",
			"1. memory.search 检索用户的长期记忆；对话里已经说过的内容不需要再去记忆里查。",
			"2. 只有用户明确要求记住、或该信息长期有效且影响后续协作时才写入记忆。",
			"3. 写入/更新/删除都是有副作用的操作，先确认再执行；不要把敏感凭据写进记忆。",
		}, "\n"),
		ToolIDs: []string{"memory.search", "memory.write", "memory.update", "memory.delete"},
		Tags:    []string{"memory"},
	})

	skills.Register(rt.AgentSkill{
		ID: "writer", Name: "写作", Description: "长文撰写、改写、归纳与结构梳理",
		Instructions: joinStrings([]string{
			"## 写作",
			"1. 写作是操作能力，不是任务分类：先把资料查够，再进入写作。",
			"2. 长篇写作前先确定结构与信息来源；正文中的事实必须来自已获取的证据。",
		}, "\n"),
		ToolIDs: []string{"writer.compose", "writer.rewrite", "writer.summarize", "writer.structure", "writer.save_artifact"},
		Tags:    []string{"generation"},
	})

	skills.Register(rt.AgentSkill{
		ID: "graph", Name: "知识图谱", Description: "实体关系、依赖与关联文章的图谱查询",
		Instructions: joinStrings([]string{
			"## 知识图谱",
			"1. 图谱适合关系型问题：实体依赖、关联文章、路径查询、多跳关系。",
			"2. 图谱不替代普通知识检索：它只覆盖已公开分享的内容，查不到私有知识库正文。",
			"3. 典型组合：knowledge.search → 图谱扩散 → knowledge.read。",
		}, "\n"),
		ToolIDs: []string{"graph.search", "graph.expand", "graph.get_entity", "graph.get_relations"},
		Deps:    []string{"knowledge"},
		Tags:    []string{"retrieval"},
	})

	skills.Register(rt.AgentSkill{
		ID: "admin", Name: "管理", Description: "模型配置、API Key 与站点开关等管理操作",
		Instructions: joinStrings([]string{
			"## 管理操作",
			"1. 管理能力仅限操作员；没有权限时如实说明，不要绕路尝试。",
			"2. bind_ai_model 可在用户明确要求时直接执行；删除供应商、轮换凭证、吊销 Agent Key、修改公开问答开关必须调用 request_user_confirmation。",
			"3. 对应 action.toolName 分别是 delete_ai_provider、update_ai_credential、revoke_agent_api_key、set_public_qa_enabled。",
		}, "\n"),
		ToolIDs: []string{"admin.list_models", "admin.bind_model", "admin.list_api_keys", "admin.get_public_qa", "agent.request_confirmation"},
		Tags:    []string{"admin"},
	})

	skills.Register(rt.AgentSkill{
		ID: "system", Name: "站点概览", Description: "系统与资源清单概览",
		Instructions: joinStrings([]string{
			"## 站点概览",
			"1. 回答\"有多少知识库/文档库/文章\"这类计数与清单问题时，优先用概览类工具，不要对每个库分别做一次检索。",
			"2. 概览结果只说明有什么，不说明内容；要回答内容问题仍需检索。",
		}, "\n"),
		ToolIDs: []string{"system.overview"},
		Tags:    []string{"system"},
	})
}
