package about

import (
	"strings"
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

func TestBuildProfileResponseFallsBackLikeLegacy(t *testing.T) {
	empty := buildProfileResponse(nil)
	if empty.DisplayName != "CiZai" || empty.CreatedAt != nil || len(empty.Accents) == 0 {
		t.Fatalf("unexpected default profile: %#v", empty)
	}
	row := &ent.SiteAboutProfile{
		DisplayName: " ", RoleTitle: " ", Intro: " ", Quote: " ",
		ExpertiseJSON: "{bad", ToolkitJSON: `[]`, AccentsJSON: `[]`,
		ContactText: "", ContactLabel: "", ContactHref: "",
	}
	result := buildProfileResponse(row)
	if result.DisplayName != defaultProfile.DisplayName || len(result.Expertise) != len(defaultProfile.Expertise) {
		t.Fatalf("damaged profile did not fall back: %#v", result)
	}
	if len(result.Toolkit) != len(defaultProfile.Toolkit) || len(result.Accents) != 0 {
		t.Fatalf("list/accent fallback semantics changed: %#v", result)
	}
	if result.ContactText != "" || result.ContactHref != "" {
		t.Fatalf("explicitly cleared contact fields were not preserved: %#v", result)
	}
}

func TestValidateProfileInputNormalizesAndValidates(t *testing.T) {
	input, err := validateProfileInput(map[string]any{
		"displayName": "  CiZai  ", "roleTitle": " Creative Dev ",
		"intro":     " 第一段 \r\n\r\n 第二段 ",
		"expertise": []any{" AI ", "", "Coding", "AI"},
		"toolkit":   "TypeScript\n\nReact\nTypeScript", "quote": " Code is paint. ",
		"accents": []any{
			map[string]any{"phrase": " CiZai ", "style": "red", "note": " hey "},
			map[string]any{"phrase": "CiZai", "style": "blue"},
			map[string]any{"phrase": "x", "style": "rainbow"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if input.Intro != "第一段\n\n第二段" || len(input.Expertise) != 2 || len(input.Toolkit) != 2 {
		t.Fatalf("unexpected normalized profile: %#v", input)
	}
	if len(input.Accents) != 2 || input.Accents[1].Style != "red" {
		t.Fatalf("unexpected accents: %#v", input.Accents)
	}
	_, err = validateProfileInput(map[string]any{
		"displayName": " ", "roleTitle": "dev", "intro": "intro",
		"expertise": []any{"AI"}, "toolkit": []any{"TS"}, "quote": "q",
	})
	if err == nil || !strings.Contains(err.Error(), "名称不能为空") {
		t.Fatalf("expected empty name error, got %v", err)
	}
}
