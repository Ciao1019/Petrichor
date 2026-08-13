package appearance

import "testing"

func TestAppearanceDefaultsMatchLegacyContract(t *testing.T) {
	response := buildResponse(nil)
	if !response.PublicQaEnabled || response.CreatedAt != nil || response.UpdatedAt != nil {
		t.Fatalf("unexpected default response: %#v", response)
	}
	if resolvePublicQAEnabled(map[string]any{"publicQaEnabled": false}) {
		t.Fatal("explicit false was not preserved")
	}
	if !resolvePublicQAEnabled(map[string]any{"publicQaEnabled": "yes"}) {
		t.Fatal("invalid value should fall back to true")
	}
}
