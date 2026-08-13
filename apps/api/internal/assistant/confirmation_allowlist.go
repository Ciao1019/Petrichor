package assistant

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/assistantthread"
)

const dangerAllowlistTTL = 24 * time.Hour

var destructiveCriticalTools = map[string]struct{}{
	"delete_article":        {},
	"delete_document":       {},
	"delete_ai_config":      {},
	"revoke_article_share":  {},
	"revoke_agent_api_key":  {},
	"set_public_qa_enabled": {},
}

type dangerAllowlistState struct {
	ToolNames []string `json:"toolNames"`
	UpdatedAt string   `json:"updatedAt"`
}

func IsDestructiveCriticalTool(toolName string) bool {
	_, ok := destructiveCriticalTools[toolName]
	return ok
}

func parseDangerAllowlistJSON(raw *string) *dangerAllowlistState {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var state dangerAllowlistState
	if err := json.Unmarshal([]byte(*raw), &state); err != nil {
		return nil
	}
	if len(state.ToolNames) == 0 || state.UpdatedAt == "" {
		return nil
	}
	return &state
}

func isAllowlistExpired(state *dangerAllowlistState, now time.Time) bool {
	t, err := time.Parse(time.RFC3339, state.UpdatedAt)
	if err != nil {
		return true
	}
	return now.Sub(t) > dangerAllowlistTTL
}

func getThreadDangerAllowlist(ctx context.Context, client *ent.Client, threadID, userID int64) (map[string]struct{}, error) {
	if threadID <= 0 {
		return map[string]struct{}{}, nil
	}
	row, err := client.AssistantThread.Query().
		Where(
			assistantthread.IDEQ(threadID),
			assistantthread.UserIDEQ(userID),
			assistantthread.DeletedAtIsNil(),
		).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return map[string]struct{}{}, nil
		}
		return nil, err
	}
	state := parseDangerAllowlistJSON(row.DangerAllowlistJSON)
	if state == nil {
		return map[string]struct{}{}, nil
	}
	if isAllowlistExpired(state, time.Now().UTC()) {
		_ = clearThreadDangerAllowlist(ctx, client, threadID, userID)
		return map[string]struct{}{}, nil
	}
	out := make(map[string]struct{}, len(state.ToolNames))
	for _, name := range state.ToolNames {
		if name != "" {
			out[name] = struct{}{}
		}
	}
	return out, nil
}

func isToolInThreadDangerAllowlist(ctx context.Context, client *ent.Client, threadID, userID int64, toolName string) (bool, error) {
	if IsDestructiveCriticalTool(toolName) {
		return false, nil
	}
	set, err := getThreadDangerAllowlist(ctx, client, threadID, userID)
	if err != nil {
		return false, err
	}
	_, ok := set[toolName]
	return ok, nil
}

func addToolToThreadDangerAllowlist(ctx context.Context, client *ent.Client, threadID, userID int64, toolName string) error {
	if threadID <= 0 || IsDestructiveCriticalTool(toolName) {
		return nil
	}
	set, err := getThreadDangerAllowlist(ctx, client, threadID, userID)
	if err != nil {
		return err
	}
	set[toolName] = struct{}{}
	names := make([]string, 0, len(set))
	for name := range set {
		names = append(names, name)
	}
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			if names[j] < names[i] {
				names[i], names[j] = names[j], names[i]
			}
		}
	}
	next := dangerAllowlistState{
		ToolNames: names,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	raw, _ := json.Marshal(next)
	_, err = client.AssistantThread.Update().
		Where(assistantthread.IDEQ(threadID), assistantthread.UserIDEQ(userID), assistantthread.DeletedAtIsNil()).
		SetDangerAllowlistJSON(string(raw)).
		Save(ctx)
	return err
}

func clearThreadDangerAllowlist(ctx context.Context, client *ent.Client, threadID, userID int64) error {
	_, err := client.AssistantThread.Update().
		Where(assistantthread.IDEQ(threadID), assistantthread.UserIDEQ(userID)).
		ClearDangerAllowlistJSON().
		Save(ctx)
	return err
}

func dangerousToolWhitelist(toolName string) (string, bool) {
	m := map[string]string{
		"delete_article":               "article.delete",
		"revoke_article_share":         "share.revoke",
		"delete_document":              "document.delete",
		"delete_ai_config":             "ai_config.delete",
		"update_ai_config_credentials": "ai_config.update_credentials",
		"revoke_agent_api_key":         "agent_api_key.revoke",
		"set_public_qa_enabled":        "public_qa.set_enabled",
	}
	v, ok := m[toolName]
	return v, ok
}

func isDangerousToolName(toolName string) bool {
	_, ok := dangerousToolWhitelist(toolName)
	return ok
}

func assertConfirmationAction(toolName string) error {
	if _, ok := dangerousToolWhitelist(toolName); !ok {
		return fmt.Errorf("不允许确认执行未知危险工具：%s", toolName)
	}
	reg := GetToolRegistration(toolName)
	if reg == nil || reg.Risk != "dangerous" {
		return fmt.Errorf("危险工具未注册：%s", toolName)
	}
	return nil
}
