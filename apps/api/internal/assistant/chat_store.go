package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/cloudwego/eino/schema"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantmessage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantrun"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantstep"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantthread"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

func (r *Runtime) ensureAssistantChatThread(
	ctx context.Context,
	userID int64,
	threadID *int64,
	title string,
	focus *AssistantFocus,
) (*ent.AssistantThread, error) {
	if threadID != nil {
		row, err := r.client.AssistantThread.Query().
			Where(
				assistantthread.IDEQ(*threadID),
				assistantthread.UserIDEQ(userID),
				assistantthread.DeletedAtIsNil(),
			).
			Only(ctx)
		if ent.IsNotFound(err) {
			return nil, response.NotFound("对话不存在")
		}
		return row, err
	}

	builder := r.client.AssistantThread.Create().
		SetUserID(userID).
		SetTitle(summarizeThreadTitle(title))
	if focus != nil {
		raw, err := json.Marshal(focus)
		if err != nil {
			return nil, err
		}
		builder.SetFocusJSON(string(raw))
	}
	return builder.Save(ctx)
}

func (r *Runtime) truncateAssistantThreadMessages(ctx context.Context, threadID int64, keepCount int) (int, error) {
	if keepCount < 0 {
		keepCount = 0
	}
	rows, err := r.client.AssistantMessage.Query().
		Where(assistantmessage.ThreadIDEQ(threadID)).
		Order(ent.Asc(assistantmessage.FieldCreatedAt), ent.Asc(assistantmessage.FieldID)).
		All(ctx)
	if err != nil || len(rows) <= keepCount {
		return 0, err
	}
	ids := make([]int64, 0, len(rows)-keepCount)
	for _, row := range rows[keepCount:] {
		ids = append(ids, row.ID)
	}
	return r.client.AssistantMessage.Delete().Where(assistantmessage.IDIn(ids...)).Exec(ctx)
}

func (r *Runtime) persistAssistantChatMessage(
	ctx context.Context,
	userID int64,
	threadID int64,
	role string,
	content any,
	titleCandidate string,
) error {
	raw, err := json.Marshal(content)
	if err != nil {
		return err
	}
	if _, err := r.client.AssistantMessage.Create().
		SetThreadID(threadID).
		SetRole(role).
		SetContentJSON(string(raw)).
		Save(ctx); err != nil {
		return err
	}
	update := r.client.AssistantThread.Update().
		Where(assistantthread.IDEQ(threadID), assistantthread.UserIDEQ(userID)).
		SetUpdatedAt(time.Now().UTC())
	if role == "user" && strings.TrimSpace(titleCandidate) != "" {
		update.SetTitle(summarizeThreadTitle(titleCandidate))
	}
	_, err = update.Save(ctx)
	return err
}

func chatMessagePersistedValue(message chatUIMessage) any {
	if len(message.raw) > 0 && json.Valid(message.raw) {
		var value any
		if json.Unmarshal(message.raw, &value) == nil {
			return value
		}
	}
	return message
}

func (r *Runtime) listRecentAssistantSignals(ctx context.Context, threadID int64) ([]string, []AgentDomainId, error) {
	lastRun, err := r.client.AssistantRun.Query().
		Where(assistantrun.ThreadIDEQ(threadID)).
		Order(ent.Desc(assistantrun.FieldStartedAt), ent.Desc(assistantrun.FieldID)).
		First(ctx)
	if ent.IsNotFound(err) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	steps, err := r.client.AssistantStep.Query().
		Where(assistantstep.RunIDEQ(lastRun.ID)).
		Order(ent.Asc(assistantstep.FieldStepIndex), ent.Asc(assistantstep.FieldID)).
		All(ctx)
	if err != nil {
		return nil, nil, err
	}
	toolNames := make([]string, 0, len(steps))
	for _, step := range steps {
		if strings.TrimSpace(step.ToolName) != "" {
			toolNames = append(toolNames, step.ToolName)
		}
	}
	domains := parseAssistantDomains(lastRun.IntentDomainsJSON)
	return toolNames, domains, nil
}

func parseAssistantDomains(raw *string) []AgentDomainId {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var values []string
	if json.Unmarshal([]byte(*raw), &values) != nil {
		return nil
	}
	valid := map[AgentDomainId]struct{}{
		DomainKnowledge: {}, DomainSystem: {}, DomainContentWrite: {}, DomainAdmin: {},
	}
	out := make([]AgentDomainId, 0, len(values))
	for _, value := range values {
		domain := AgentDomainId(value)
		if _, ok := valid[domain]; ok {
			out = append(out, domain)
		}
	}
	return out
}

func mergeRecentToolNames(databaseNames, messageNames []string) []string {
	seen := make(map[string]struct{}, len(databaseNames)+len(messageNames))
	out := make([]string, 0, len(databaseNames)+len(messageNames))
	for _, group := range [][]string{databaseNames, messageNames} {
		for _, name := range group {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			out = append(out, name)
			if len(out) >= 16 {
				return out
			}
		}
	}
	return out
}

func (r *Runtime) createAssistantRun(ctx context.Context, threadID, modelConfigID int64, domains []AgentDomainId) (*ent.AssistantRun, error) {
	return r.client.AssistantRun.Create().
		SetThreadID(threadID).
		SetStatus("RUNNING").
		SetModelConfigID(modelConfigID).
		SetIntentDomainsJSON(mustJSON(domains)).
		Save(ctx)
}

func (r *Runtime) updateAssistantRunIntent(ctx context.Context, runID int64, domains []AgentDomainId) error {
	_, err := r.client.AssistantRun.UpdateOneID(runID).
		SetIntentDomainsJSON(mustJSON(domains)).
		Save(ctx)
	return err
}

func (r *Runtime) finishAssistantRun(ctx context.Context, runID int64, status, errorCode string) error {
	update := r.client.AssistantRun.UpdateOneID(runID).
		SetStatus(status).
		SetFinishedAt(time.Now().UTC())
	if strings.TrimSpace(errorCode) == "" {
		update.ClearErrorCode()
	} else {
		update.SetErrorCode(errorCode)
	}
	_, err := update.Save(ctx)
	return err
}

type assistantStepRecord struct {
	RunID      int64
	StepIndex  int
	ToolName   string
	Input      any
	Output     any
	Status     string
	ErrorCode  string
	DurationMs *int
}

func (r *Runtime) recordAssistantStep(ctx context.Context, record assistantStepRecord) error {
	if record.RunID <= 0 {
		return nil
	}
	builder := r.client.AssistantStep.Create().
		SetRunID(record.RunID).
		SetStepIndex(record.StepIndex).
		SetToolName(record.ToolName).
		SetStatus(record.Status)
	if record.Input != nil {
		if raw, err := json.Marshal(redactAssistantStepInput(record.Input)); err == nil {
			builder.SetInputJSON(string(raw))
		}
	}
	if record.Output != nil {
		if raw, err := json.Marshal(record.Output); err == nil {
			builder.SetOutputJSON(string(raw))
		}
	}
	if strings.TrimSpace(record.ErrorCode) != "" {
		builder.SetErrorCode(record.ErrorCode)
	}
	if record.DurationMs != nil {
		builder.SetDurationMs(*record.DurationMs)
	}
	_, err := builder.Save(ctx)
	return err
}

var sensitiveAssistantStepKeys = map[string]struct{}{
	"apikey": {}, "api_key": {}, "password": {}, "secret": {}, "token": {},
	"access_token": {}, "refresh_token": {}, "authorization": {}, "cookie": {},
}

func redactAssistantStepInput(input any) any {
	switch value := input.(type) {
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = redactAssistantStepInput(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(value))
		for key, item := range value {
			if _, sensitive := sensitiveAssistantStepKeys[strings.ToLower(key)]; sensitive {
				out[key] = "[redacted]"
			} else {
				out[key] = redactAssistantStepInput(item)
			}
		}
		return out
	default:
		return input
	}
}

func chatMessagesForModel(messages []chatUIMessage) []*schema.Message {
	out := make([]*schema.Message, 0, len(messages))
	for _, message := range messages {
		text := extractMessageModelText(message)
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

func extractMessageModelText(message chatUIMessage) string {
	parts := make([]string, 0, len(message.Parts)+1)
	if text := extractMessagePlainText(message); text != "" {
		parts = append(parts, text)
	}
	for _, part := range message.Parts {
		toolName := chatPartToolName(part)
		if toolName == "" {
			continue
		}
		output := chatPartOutput(part)
		if output == nil {
			continue
		}
		raw, err := json.Marshal(output)
		if err == nil {
			parts = append(parts, fmt.Sprintf("[工具 %s 的历史结果] %s", toolName, string(raw)))
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

type operatorMemorySnapshot struct {
	UserProfileMd string `json:"userProfileMd"`
	AgentNotesMd  string `json:"agentNotesMd"`
	FrozenAt      string `json:"frozenAt"`
}

func (r *Runtime) loadOperatorMemoryPromptSection(ctx context.Context, userID, threadID int64, operator bool) (string, error) {
	if !operator {
		return "", nil
	}
	thread, err := r.client.AssistantThread.Query().
		Where(assistantthread.IDEQ(threadID), assistantthread.UserIDEQ(userID)).
		Only(ctx)
	if err != nil {
		return "", err
	}
	var snapshot operatorMemorySnapshot
	if thread.OperatorMemorySnapshotJSON != nil {
		_ = json.Unmarshal([]byte(*thread.OperatorMemorySnapshotJSON), &snapshot)
	}
	if snapshot.FrozenAt == "" {
		profile, profileErr := r.client.AssistantOperatorProfile.Get(ctx, userID)
		if profileErr != nil && !ent.IsNotFound(profileErr) {
			return "", profileErr
		}
		if profile != nil {
			snapshot.UserProfileMd = profile.UserProfileMd
			snapshot.AgentNotesMd = profile.AgentNotesMd
		}
		snapshot.FrozenAt = time.Now().UTC().Format(time.RFC3339Nano)
		raw, marshalErr := json.Marshal(snapshot)
		if marshalErr != nil {
			return "", marshalErr
		}
		if _, updateErr := r.client.AssistantThread.Update().
			Where(assistantthread.IDEQ(threadID), assistantthread.UserIDEQ(userID)).
			SetOperatorMemorySnapshotJSON(string(raw)).
			Save(ctx); updateErr != nil {
			return "", updateErr
		}
	}
	return strings.Join([]string{
		"操作员常驻记忆（本线程冻结快照）",
		"",
		"## 用户画像",
		fallbackEmptyMemory(snapshot.UserProfileMd),
		"",
		"## 约定与笔记",
		fallbackEmptyMemory(snapshot.AgentNotesMd),
	}, "\n"), nil
}

func fallbackEmptyMemory(value string) string {
	if strings.TrimSpace(value) == "" {
		return "（空）"
	}
	return strings.TrimSpace(value)
}
