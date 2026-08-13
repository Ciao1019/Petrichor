package projects

import (
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
)

func TestBuildProjectResponseFallsBackAndHonorsEmptyItems(t *testing.T) {
	empty := buildProjectResponse(nil)
	if empty.CreatedAt != nil || len(empty.Items) != 3 {
		t.Fatalf("unexpected default project response: %#v", empty)
	}
	broken := buildProjectResponse(&ent.SiteProjectShowcase{Heading: " ", ItemsJSON: "{bad"})
	if broken.Heading != defaultProjectResponse.Heading || len(broken.Items) != 3 {
		t.Fatalf("broken data did not fall back: %#v", broken)
	}
	cleared := buildProjectResponse(&ent.SiteProjectShowcase{Heading: "Projects", ItemsJSON: `[]`})
	if len(cleared.Items) != 0 {
		t.Fatalf("explicit empty item list was not preserved: %#v", cleared.Items)
	}
}

func TestValidateProjectInputRestoresNormalization(t *testing.T) {
	input, err := validateProjectInput(map[string]any{
		"heading": " 我的项目 ", "intro": " 一些东西 ",
		"items": []any{
			map[string]any{
				"name": " Ech0 ", "year": " 2025 ", "stack": []any{"Go", "Go", " Vue "},
				"stamp": " popular ", "stampColor": "rainbow", "blurb": " hello \n world ",
				"repoUrl": " https://x.dev ", "siteUrl": "",
			},
			map[string]any{"name": " "},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if input.Heading != "我的项目" || len(input.Items) != 1 {
		t.Fatalf("unexpected project input: %#v", input)
	}
	item := input.Items[0]
	if len(item.Stack) != 2 || item.StampColor != "red" || item.Blurb != "hello\nworld" || item.RepoURL != "https://x.dev" {
		t.Fatalf("unexpected normalized item: %#v", item)
	}
}
