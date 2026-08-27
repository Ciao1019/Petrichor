package assistantsvc

import (
	"encoding/json"
	"testing"
	"time"

	rt "petrichor/api/internal/assistantsvc/runtime"
)

func TestFindPendingConfirmationUsesOnlyMatchingTicketID(t *testing.T) {
	messages := []json.RawMessage{json.RawMessage(`{
		"role":"assistant",
		"parts":[{
			"type":"tool-request_user_confirmation",
			"toolCallId":"call-1",
			"input":{"id":"confirm-1","action":{"toolName":"delete_article","input":{"articleId":"1"}}},
			"output":{"confirmed":true,"confirmationId":"confirm-1","allowForThread":true}
		}]
	}`)}
	pending := findPendingConfirmationExecution(messages)
	if pending == nil || pending.ConfirmationID != "confirm-1" || !pending.AllowForThread {
		t.Fatalf("unexpected pending confirmation: %#v", pending)
	}

	// 客户端 result 的 ID 与工具原始 input 不一致时必须拒绝，防止换票。
	tampered := []json.RawMessage{json.RawMessage(`{
		"role":"assistant","parts":[{
			"type":"tool-request_user_confirmation",
			"input":{"id":"confirm-1"},
			"output":{"confirmed":true,"confirmationId":"confirm-2"}
		}]
	}`)}
	if got := findPendingConfirmationExecution(tampered); got != nil {
		t.Fatalf("mismatched confirmation id must be rejected: %#v", got)
	}
	cancelled := []json.RawMessage{json.RawMessage(`{
		"role":"assistant","parts":[{
			"type":"tool-request_user_confirmation",
			"input":{"id":"confirm-3"},
			"output":{"confirmed":false,"confirmationId":"confirm-3","cancelled":true}
		}]
	}`)}
	decision := findPendingConfirmationDecision(cancelled)
	if decision == nil || decision.Confirmed || decision.ConfirmationID != "confirm-3" {
		t.Fatalf("cancel decision must be recognized for ticket invalidation: %#v", decision)
	}
}

func TestPatchConfirmationExecutionOutcomePreservesDecision(t *testing.T) {
	messages := []json.RawMessage{json.RawMessage(`{
		"role":"assistant","parts":[{
			"type":"tool-request_user_confirmation",
			"input":{"id":"confirm-1"},
			"output":{"confirmed":true,"confirmationId":"confirm-1"}
		}]
	}`)}
	patched := patchConfirmationExecutionOutcome(messages, "confirm-1", map[string]any{"deleted": true})
	var message map[string]any
	if json.Unmarshal(patched[0], &message) != nil {
		t.Fatal("patched message is invalid json")
	}
	parts := message["parts"].([]any)
	result := parts[0].(map[string]any)["output"].(map[string]any)
	if result["confirmed"] != true || result["executionOutcome"].(map[string]any)["deleted"] != true {
		t.Fatalf("decision or outcome lost: %#v", result)
	}
	if got := findPendingConfirmationExecution(patched); got != nil {
		t.Fatalf("executed confirmation must not be discovered again: %#v", got)
	}
}

func TestDangerousToolsAreRegisteredButNotOrdinarilyExposed(t *testing.T) {
	registry := rt.NewToolRegistry()
	skills := rt.NewSkillRegistry()
	RegisterAssistantTools(registry, skills)
	for publicName, id := range dangerousToolNames {
		tool := registry.Get(id)
		if tool == nil || tool.Name != publicName || !tool.RequiresConfirmation || !tool.SideEffect || tool.RiskLevel != rt.RiskHigh {
			t.Fatalf("dangerous tool contract mismatch for %s: %#v", publicName, tool)
		}
		for _, skillID := range skills.IDs() {
			for _, exposedID := range skills.Get(skillID).ToolIDs {
				if exposedID == id {
					t.Fatalf("dangerous implementation %s must not be exposed in skill %s", id, skillID)
				}
			}
		}
	}
	if registry.Get("request_user_confirmation") == nil {
		t.Fatal("confirmation request tool must be exposed by public name")
	}
}

func TestDangerousActionCannotRunWithoutServerConfirmation(t *testing.T) {
	_, err := executeConfirmedDeleteArticle(&rt.ToolExecutionContext{}, map[string]any{"articleId": "1"})
	if err == nil {
		t.Fatal("direct dangerous execution must fail closed")
	}
	agentErr := rt.NormalizeAgentError(err)
	if agentErr.Code != rt.CodePermissionDenied {
		t.Fatalf("unexpected error: %#v", agentErr)
	}
}

func TestDangerAllowlistParsingFiltersUnknownAndDeduplicates(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	raw, _ := json.Marshal(map[string]any{
		"toolNames": []string{"update_ai_credential", "unknown", "update_ai_credential"},
		"updatedAt": now.Format(time.RFC3339),
	})
	state := parseDangerAllowlist(string(raw))
	if state == nil || len(state.ToolNames) != 1 || state.ToolNames[0] != "update_ai_credential" || !state.UpdatedAt.Equal(now) {
		t.Fatalf("unexpected allowlist state: %#v", state)
	}
	if confirmationStorageKey(1, "same") == confirmationStorageKey(2, "same") {
		t.Fatal("confirmation storage keys must be isolated by thread")
	}
}
