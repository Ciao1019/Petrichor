package assistant

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantmessage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantoperatorskill"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantthread"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/vector"
)

func registerMiscTools() {
	registerTools([]ToolRegistration{
		{Name: "load_skill", Domain: DomainSystem, Risk: RiskRead, Description: "按需加载业务 playbook。", Factory: newLoadSkillTool},
		{Name: "memory_manage", Domain: DomainSystem, Risk: RiskWrite, RequiresOperator: true, Description: "维护操作员记忆。", Factory: newMemoryManageTool},
		{Name: "search_operator_history", Domain: DomainSystem, Risk: RiskRead, RequiresOperator: true, Description: "检索操作员历史。", Factory: newSearchOperatorHistoryTool},
	})
}

type assistantSkillDefinition struct {
	Name         string
	Description  string
	Instructions string
	Domains      []AgentDomainId
}

var builtinSkills = map[string]assistantSkillDefinition{
	"knowledge-qa": {
		Name: "knowledge-qa", Description: "知识库/文章问答与引用", Domains: []AgentDomainId{DomainKnowledge},
		Instructions: strings.TrimSpace(`
## 知识库问答流程

1. 优先沿用当前 focus 的知识库范围；用户明确要求跨库时再放开。
2. 计数或清单优先 list_system_overview / list_knowledge_bases，不要逐库搜索。
3. 查内容先 search_knowledge，按 hits 的 knowledgeBaseId 再 read_knowledge_node 深读。
4. 最终答案必须基于工具返回内容；调用 show_citations，禁止编造引用。
5. 图片用 Markdown，src 使用 media.src 原值。
6. 检索不到就如实说明；多步任务用 show_progress 或 upsert_plan。`),
	},
	"article-write": {
		Name: "article-write", Description: "写改/移动文章、分享与危险删除", Domains: []AgentDomainId{DomainContentWrite},
		Instructions: strings.TrimSpace(`
## 内容写入流程

1. 普通写入用 create_article / update_article / create_article_share。
2. 大段改写前先 preview_article_update，再 update_article 落库。
3. 移动文章用 move_article；复杂写入可先 spawn_write_subagent 规划。
4. 删除文章、撤销分享、删除文档必须 request_user_confirmation，禁止假装已执行。
5. 两步及以上写改必须 upsert_plan，每完成一步更新 status。`),
	},
	"admin-ops": {
		Name: "admin-ops", Description: "模型配置 / API Key / 公开问答", Domains: []AgentDomainId{DomainAdmin},
		Instructions: strings.TrimSpace(`
## 管理面流程

1. 查询用 list_ai_configs / list_agent_api_keys / get_public_qa_setting。
2. set_default_ai_config 可直接执行。
3. 删除配置、更新密钥、吊销 API Key、修改公开问答开关必须 request_user_confirmation。
4. 公开问答开关仅超级管理员可改。`),
	},
}

type loadSkillInput struct {
	Name string `json:"name"`
}

func newLoadSkillTool() tool.InvokableTool {
	t, err := utils.InferTool("load_skill", "加载 skill。", func(ctx context.Context, input *loadSkillInput) (map[string]any, error) {
		name := strings.TrimSpace(input.Name)
		if name == "" || utf8.RuneCountInString(name) > 64 {
			return map[string]any{"ok": false, "errorCode": "invalid_skill_name", "message": "name 长度必须在 1 到 64 之间"}, nil
		}
		if isOperator(systemRoleFrom(ctx)) {
			client, clientErr := clientFrom(ctx)
			userID, userErr := userIDFrom(ctx)
			if clientErr != nil {
				return nil, clientErr
			}
			if userErr != nil {
				return nil, userErr
			}
			row, queryErr := client.AssistantOperatorSkill.Query().
				Where(
					assistantoperatorskill.UserIDEQ(userID),
					assistantoperatorskill.NameEQ(name),
					assistantoperatorskill.StatusEQ("active"),
				).
				Only(ctx)
			if queryErr == nil {
				return map[string]any{"ok": true, "name": row.Name, "description": row.Description, "instructions": row.BodyMd, "source": "operator"}, nil
			}
			if !ent.IsNotFound(queryErr) {
				return nil, queryErr
			}
		}
		if skill, ok := builtinSkills[name]; ok {
			return map[string]any{"ok": true, "name": skill.Name, "description": skill.Description, "instructions": skill.Instructions, "source": "builtin"}, nil
		}
		names, listErr := listAvailableAssistantSkillNames(ctx)
		if listErr != nil {
			return nil, listErr
		}
		return map[string]any{"ok": false, "errorCode": "skill_not_found", "message": "未知 skill：" + name, "available": names}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func listAvailableAssistantSkillNames(ctx context.Context) ([]string, error) {
	seen := make(map[string]struct{}, len(builtinSkills))
	for name := range builtinSkills {
		seen[name] = struct{}{}
	}
	if isOperator(systemRoleFrom(ctx)) {
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		rows, err := client.AssistantOperatorSkill.Query().
			Where(assistantoperatorskill.UserIDEQ(userID), assistantoperatorskill.StatusEQ("active")).
			All(ctx)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			seen[row.Name] = struct{}{}
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

func (r *Runtime) listOperatorSkillPromptLines(ctx context.Context, userID int64, domains []AgentDomainId) ([]string, error) {
	rows, err := r.client.AssistantOperatorSkill.Query().
		Where(assistantoperatorskill.UserIDEQ(userID), assistantoperatorskill.StatusEQ("active")).
		Order(ent.Asc(assistantoperatorskill.FieldName)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		lines = append(lines, "- "+row.Name+"："+row.Description)
	}
	return lines, nil
}

type memoryManageInput struct {
	Action  string  `json:"action"`
	Target  string  `json:"target"`
	Text    *string `json:"text,omitempty"`
	OldText *string `json:"old_text,omitempty"`
	NewText *string `json:"new_text,omitempty"`
}

const (
	operatorUserProfileMaxChars = 1375
	operatorAgentNotesMaxChars  = 2200
	operatorMemoryTotalMaxChars = 3575
)

func applyOperatorMemoryMutation(userProfile, agentNotes string, input memoryManageInput) (string, string, string) {
	if input.Target != "user_profile" && input.Target != "agent_notes" {
		return userProfile, agentNotes, "invalid_patch"
	}
	current := userProfile
	if input.Target == "agent_notes" {
		current = agentNotes
	}
	next := current
	switch input.Action {
	case "add":
		if input.Text == nil || strings.TrimSpace(*input.Text) == "" {
			return userProfile, agentNotes, "invalid_patch"
		}
		addition := strings.TrimSpace(*input.Text)
		if strings.TrimSpace(current) == "" {
			next = addition
		} else {
			next = strings.TrimRight(current, " \t\r\n") + "\n" + addition
		}
	case "replace":
		if input.OldText == nil || *input.OldText == "" || input.NewText == nil || !strings.Contains(current, *input.OldText) {
			return userProfile, agentNotes, "invalid_patch"
		}
		next = strings.Replace(current, *input.OldText, *input.NewText, 1)
	case "remove":
		if input.OldText == nil || *input.OldText == "" || !strings.Contains(current, *input.OldText) {
			return userProfile, agentNotes, "invalid_patch"
		}
		next = strings.Replace(current, *input.OldText, "", 1)
	default:
		return userProfile, agentNotes, "invalid_patch"
	}
	if input.Target == "user_profile" {
		userProfile = next
	} else {
		agentNotes = next
	}
	profileChars := utf8.RuneCountInString(userProfile)
	notesChars := utf8.RuneCountInString(agentNotes)
	if profileChars > operatorUserProfileMaxChars || notesChars > operatorAgentNotesMaxChars || profileChars+notesChars > operatorMemoryTotalMaxChars {
		return userProfile, agentNotes, "memory_limit_exceeded"
	}
	return userProfile, agentNotes, ""
}

func newMemoryManageTool() tool.InvokableTool {
	t, err := utils.InferTool("memory_manage", "操作员记忆。", func(ctx context.Context, input *memoryManageInput) (map[string]any, error) {
		if !isOperator(systemRoleFrom(ctx)) {
			return map[string]any{"ok": false, "errorCode": "assistant_operator_only"}, nil
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		profile, profileErr := client.AssistantOperatorProfile.Get(ctx, userID)
		if profileErr != nil && !ent.IsNotFound(profileErr) {
			return nil, profileErr
		}
		userProfile := ""
		agentNotes := ""
		if profile != nil {
			userProfile = profile.UserProfileMd
			agentNotes = profile.AgentNotesMd
		}
		nextProfile, nextNotes, errorCode := applyOperatorMemoryMutation(userProfile, agentNotes, *input)
		if errorCode != "" {
			message := "记忆修改参数无效"
			if errorCode == "memory_limit_exceeded" {
				message = "记忆内容超过长度限制"
			}
			return map[string]any{"ok": false, "errorCode": errorCode, "message": message}, nil
		}
		if profile == nil {
			_, err = client.AssistantOperatorProfile.Create().
				SetID(userID).
				SetUserProfileMd(nextProfile).
				SetAgentNotesMd(nextNotes).
				Save(ctx)
		} else {
			_, err = profile.Update().
				SetUserProfileMd(nextProfile).
				SetAgentNotesMd(nextNotes).
				Save(ctx)
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"ok": true, "userProfileChars": utf8.RuneCountInString(nextProfile),
			"agentNotesChars": utf8.RuneCountInString(nextNotes), "applied": "profile_only",
		}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

type searchOperatorHistoryInput struct {
	Query                string `json:"query"`
	Mode                 string `json:"mode,omitempty"`
	Limit                *int   `json:"limit,omitempty"`
	ExcludeCurrentThread *bool  `json:"excludeCurrentThread,omitempty"`
}

func newSearchOperatorHistoryTool() tool.InvokableTool {
	t, err := utils.InferTool("search_operator_history", "检索历史。", func(ctx context.Context, input *searchOperatorHistoryInput) (map[string]any, error) {
		if !isOperator(systemRoleFrom(ctx)) {
			return map[string]any{"ok": false, "errorCode": "assistant_operator_only"}, nil
		}
		client, err := clientFrom(ctx)
		if err != nil {
			return nil, err
		}
		userID, err := userIDFrom(ctx)
		if err != nil {
			return nil, err
		}
		limit := 8
		if input.Limit != nil {
			limit = *input.Limit
		}
		if limit < 1 || limit > 20 {
			return map[string]any{"ok": false, "errorCode": "invalid_request", "message": "limit 必须在 1 到 20 之间"}, nil
		}
		query := strings.TrimSpace(input.Query)
		if query == "" || utf8.RuneCountInString(query) > 500 {
			return map[string]any{"ok": false, "errorCode": "invalid_request", "message": "query 长度必须在 1 到 500 之间"}, nil
		}
		mode := strings.ToLower(strings.TrimSpace(input.Mode))
		if mode == "" {
			mode = "both"
		}
		if mode != "keyword" && mode != "semantic" && mode != "both" {
			return map[string]any{"ok": false, "errorCode": "invalid_request", "message": "mode 必须是 keyword、semantic 或 both"}, nil
		}
		excludeCurrent := true
		if input.ExcludeCurrentThread != nil {
			excludeCurrent = *input.ExcludeCurrentThread
		}
		var excludeThreadID int64
		if excludeCurrent {
			excludeThreadID = threadIDFrom(ctx)
		}
		runtime, _ := ctx.Value(ctxKeyRuntime{}).(*Runtime)
		keywordHits := []map[string]any{}
		semanticHits := []map[string]any{}
		if mode == "keyword" || mode == "both" {
			keywordHits = searchOperatorHistoryKeyword(ctx, runtime, client, userID, query, limit, excludeThreadID)
		}
		if mode == "semantic" || mode == "both" {
			semanticHits = searchOperatorHistorySemantic(ctx, runtime, userID, query, limit, excludeThreadID)
		}
		return map[string]any{"ok": true, "hits": mergeOperatorHistoryHits(semanticHits, keywordHits, limit)}, nil
	})
	if err != nil {
		panic(err)
	}
	return t
}

func searchOperatorHistoryKeyword(
	ctx context.Context,
	runtime *Runtime,
	client *ent.Client,
	userID int64,
	query string,
	limit int,
	excludeThreadID int64,
) []map[string]any {
	if runtime != nil && runtime.sql != nil {
		statement := `
			select e.thread_id, e.message_id, e.excerpt_md,
				ts_rank(to_tsvector('simple', coalesce(e.excerpt_md, '')), plainto_tsquery('simple', $2))::float8 as score
			from petrichor_assistant_message_embedding e
			where e.user_id = $1
			  and to_tsvector('simple', coalesce(e.excerpt_md, '')) @@ plainto_tsquery('simple', $2)
			order by score desc
			limit $3`
		args := []any{userID, query, limit}
		if excludeThreadID > 0 {
			statement = `
				select e.thread_id, e.message_id, e.excerpt_md,
					ts_rank(to_tsvector('simple', coalesce(e.excerpt_md, '')), plainto_tsquery('simple', $2))::float8 as score
				from petrichor_assistant_message_embedding e
				where e.user_id = $1 and e.thread_id <> $3
				  and to_tsvector('simple', coalesce(e.excerpt_md, '')) @@ plainto_tsquery('simple', $2)
				order by score desc
				limit $4`
			args = []any{userID, query, excludeThreadID, limit}
		}
		if rows, err := runtime.sql.QueryContext(ctx, statement, args...); err == nil {
			defer rows.Close()
			hits := scanOperatorHistoryRows(rows, "keyword", 0)
			if len(hits) > 0 {
				return hits
			}
		}
	}
	return searchOperatorHistoryOwnedMessages(ctx, client, userID, query, limit, excludeThreadID)
}

type operatorHistoryRows interface {
	Next() bool
	Scan(...any) error
}

func scanOperatorHistoryRows(rows operatorHistoryRows, source string, minScore float64) []map[string]any {
	hits := make([]map[string]any, 0, 8)
	for rows.Next() {
		var threadID, messageID int64
		var excerpt string
		var score float64
		if rows.Scan(&threadID, &messageID, &excerpt, &score) != nil || score < minScore {
			continue
		}
		excerpt = sanitizeRecallExcerpt(excerpt)
		if excerpt == "" {
			continue
		}
		hits = append(hits, map[string]any{
			"threadId": fmt.Sprintf("%d", threadID), "messageId": fmt.Sprintf("%d", messageID),
			"excerpt": excerpt, "score": score, "source": source,
		})
	}
	return hits
}

func searchOperatorHistoryOwnedMessages(ctx context.Context, client *ent.Client, userID int64, query string, limit int, excludeThreadID int64) []map[string]any {
	threads, err := client.AssistantThread.Query().
		Where(assistantthread.UserIDEQ(userID)).
		Select(assistantthread.FieldID).
		All(ctx)
	if err != nil {
		return nil
	}
	threadIDs := make([]int64, 0, len(threads))
	for _, thread := range threads {
		if thread.ID != excludeThreadID {
			threadIDs = append(threadIDs, thread.ID)
		}
	}
	if len(threadIDs) == 0 {
		return nil
	}
	messages, err := client.AssistantMessage.Query().
		Where(assistantmessage.ThreadIDIn(threadIDs...)).
		Order(ent.Desc(assistantmessage.FieldCreatedAt), ent.Desc(assistantmessage.FieldID)).
		Limit(500).
		All(ctx)
	if err != nil {
		return nil
	}
	needle := strings.ToLower(query)
	hits := make([]map[string]any, 0, limit)
	for _, message := range messages {
		text := extractPlainFromContentJSON(message.ContentJSON)
		if !strings.Contains(strings.ToLower(text), needle) {
			continue
		}
		hits = append(hits, map[string]any{
			"threadId": fmt.Sprintf("%d", message.ThreadID), "messageId": fmt.Sprintf("%d", message.ID),
			"excerpt": sanitizeRecallExcerpt(text), "score": 0.5, "source": "keyword",
		})
		if len(hits) >= limit {
			break
		}
	}
	return hits
}

func searchOperatorHistorySemantic(ctx context.Context, runtime *Runtime, userID int64, query string, limit int, excludeThreadID int64) []map[string]any {
	if runtime == nil || runtime.sql == nil || runtime.gen == nil {
		return nil
	}
	ok, err := ai.HasEmbeddingConfig(ctx, runtime.client, userID)
	if err != nil || !ok {
		return nil
	}
	config, err := ai.ResolveEmbeddingConfig(ctx, runtime.client, userID, nil)
	if err != nil {
		return nil
	}
	queryRunes := []rune(query)
	if len(queryRunes) > 4000 {
		query = string(queryRunes[:4000])
	}
	vectors, err := runtime.gen.Embed(ctx, config, []string{query})
	if err != nil || len(vectors) == 0 || len(vectors[0]) == 0 {
		return nil
	}
	literal := vector.FormatPGVector(vectors[0])
	statement := `
		select e.thread_id, e.message_id, e.excerpt_md,
			(1 - (e.embedding <=> $2::vector))::float8 as score
		from petrichor_assistant_message_embedding e
		where e.user_id = $1 and e.embedding is not null
		order by e.embedding <=> $2::vector
		limit $3`
	args := []any{userID, literal, limit}
	if excludeThreadID > 0 {
		statement = `
			select e.thread_id, e.message_id, e.excerpt_md,
				(1 - (e.embedding <=> $2::vector))::float8 as score
			from petrichor_assistant_message_embedding e
			where e.user_id = $1 and e.thread_id <> $3 and e.embedding is not null
			order by e.embedding <=> $2::vector
			limit $4`
		args = []any{userID, literal, excludeThreadID, limit}
	}
	rows, err := runtime.sql.QueryContext(ctx, statement, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	return scanOperatorHistoryRows(rows, "semantic", contextRecallMinScore)
}

func mergeOperatorHistoryHits(semantic, keyword []map[string]any, limit int) []map[string]any {
	seen := make(map[string]struct{}, len(semantic)+len(keyword))
	out := make([]map[string]any, 0, limit)
	for _, group := range [][]map[string]any{semantic, keyword} {
		for _, hit := range group {
			key := fmt.Sprint(hit["threadId"]) + ":" + fmt.Sprint(hit["messageId"])
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, hit)
			if len(out) >= limit {
				return out
			}
		}
	}
	return out
}

func truncate(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[:n]) + "…"
}
