package assistant

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantplan"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantthread"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
)

func registerSystemTools() {
	registerTools([]ToolRegistration{
		{Name: "list_system_overview", Domain: DomainSystem, Risk: RiskRead, Description: "读取系统概览计数与模型就绪状态。", Factory: newListSystemOverviewTool},
		{Name: "show_progress", Domain: DomainSystem, Risk: RiskRead, Description: "回显多步任务进度。", Factory: newShowProgressTool},
		{Name: "show_citations", Domain: DomainSystem, Risk: RiskRead, Description: "回显引用列表。", Factory: newShowCitationsTool},
		{Name: "show_data_table", Domain: DomainSystem, Risk: RiskRead, Description: "回显结构化表格。", Factory: newShowDataTableTool},
		{Name: "save_answer_artifact", Domain: DomainSystem, Risk: RiskWrite, Description: "保存 Assistant 产物。", Factory: newSaveAnswerArtifactTool},
		{Name: "upsert_plan", Domain: DomainSystem, Risk: RiskWrite, Description: "创建或更新计划。", Factory: newUpsertPlanTool},
	})
}

func newListSystemOverviewTool() tool.InvokableTool {
	t, err := utils.InferTool("list_system_overview", "系统概览。", func(ctx context.Context, _ *struct{}) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		kbCount, err := client.KnowledgeBase.Query().Where(knowledgebase.UserIDEQ(userID)).Count(ctx)
		if err != nil {
			return nil, err
		}
		articleCount, err := client.KBArticle.Query().Where(kbarticle.UserIDEQ(userID)).Count(ctx)
		if err != nil {
			return nil, err
		}
		docCount, err := client.KBDocument.Query().Where(kbdocument.UserIDEQ(userID)).Count(ctx)
		if err != nil {
			return nil, err
		}
		threadCount, err := client.AssistantThread.Query().Where(assistantthread.UserIDEQ(userID), assistantthread.DeletedAtIsNil()).Count(ctx)
		if err != nil {
			return nil, err
		}
		chatReady, err := client.AIModelConfig.Query().Where(
			aimodelconfig.UserIDEQ(userID), aimodelconfig.EnabledEQ(true), aimodelconfig.IsDefaultEQ(true), aimodelconfig.ConfigTypeEQ("CHAT"),
		).Exist(ctx)
		if err != nil {
			return nil, err
		}
		embedReady, err := client.AIModelConfig.Query().Where(
			aimodelconfig.UserIDEQ(userID), aimodelconfig.EnabledEQ(true), aimodelconfig.IsDefaultEQ(true), aimodelconfig.ConfigTypeEQ("EMBEDDING"),
		).Exist(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"knowledgeBases":      kbCount,
			"articles":            articleCount,
			"documents":           docCount,
			"assistantThreads":    threadCount,
			"chatModelReady":      chatReady,
			"embeddingModelReady": embedReady,
		}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func newShowProgressTool() tool.InvokableTool {
	t, err := utils.InferTool("show_progress", "回显进度。", func(_ context.Context, input *map[string]any) (map[string]any, error) {
		if input == nil {
			return map[string]any{}, nil
		}
		return *input, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func newShowCitationsTool() tool.InvokableTool {
	t, err := utils.InferTool("show_citations", "回显引用。", func(_ context.Context, input *map[string]any) (map[string]any, error) {
		if input == nil {
			return map[string]any{"citations": []any{}}, nil
		}
		return *input, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func newShowDataTableTool() tool.InvokableTool {
	t, err := utils.InferTool("show_data_table", "回显表格。", func(_ context.Context, input *map[string]any) (map[string]any, error) {
		if input == nil {
			return map[string]any{}, nil
		}
		return *input, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type saveArtifactInput struct {
	ArtifactType string `json:"artifactType"`
	Title        string `json:"title"`
	ContentMd    string `json:"contentMd,omitempty"`
}

func newSaveAnswerArtifactTool() tool.InvokableTool {
	t, err := utils.InferTool("save_answer_artifact", "保存产物。", func(ctx context.Context, input *saveArtifactInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		threadID := threadIDFrom(ctx)
		runID := runIDFrom(ctx)
		kind := input.ArtifactType
		if kind == "" {
			kind = "answer"
		}
		payload, _ := json.Marshal(map[string]any{"contentMd": input.ContentMd})
		builder := client.AssistantArtifact.Create().SetThreadID(threadID).SetKind(kind).SetTitle(input.Title).SetContentJSON(string(payload))
		if runID > 0 {
			builder.SetRunID(runID)
		}
		row, err := builder.Save(ctx)
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": fmt.Sprintf("%d", row.ID), "artifactType": kind, "title": input.Title}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type planTodo struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Status      string `json:"status"`
	Description string `json:"description,omitempty"`
}

type upsertPlanInput struct {
	ID          string     `json:"id"`
	Title       string     `json:"title"`
	Description string     `json:"description,omitempty"`
	Todos       []planTodo `json:"todos"`
}

func newUpsertPlanTool() tool.InvokableTool {
	t, err := utils.InferTool("upsert_plan", "更新计划。", func(ctx context.Context, input *upsertPlanInput) (map[string]any, error) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		threadID := threadIDFrom(ctx)
		if input.ID == "" || input.Title == "" {
			return nil, fmt.Errorf("plan id/title 不能为空")
		}
		todosRaw, _ := json.Marshal(input.Todos)
		existing, err := client.AssistantPlan.Query().Where(assistantplan.ThreadIDEQ(threadID), assistantplan.PlanKeyEQ(input.ID)).Only(ctx)
		if ent.IsNotFound(err) {
			_, err = client.AssistantPlan.Create().
				SetThreadID(threadID).SetUserID(userID).SetPlanKey(input.ID).
				SetTitle(input.Title).SetDescription(input.Description).
				SetTodosJSON(string(todosRaw)).SetStatus("active").Save(ctx)
		} else if err == nil {
			upd := existing.Update().SetTitle(input.Title).SetTodosJSON(string(todosRaw)).SetStatus("active")
			if input.Description != "" {
				upd.SetDescription(input.Description)
			}
			_, err = upd.Save(ctx)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"id": input.ID, "title": input.Title, "todos": input.Todos}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}
