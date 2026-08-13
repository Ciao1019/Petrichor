package agent

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestAgentIDAcceptsStringAndNumber(t *testing.T) {
	for _, input := range []string{`"42"`, `42`} {
		var value agentID
		if err := json.Unmarshal([]byte(input), &value); err != nil {
			t.Fatalf("unmarshal %s: %v", input, err)
		}
		if string(value) != "42" {
			t.Fatalf("unmarshal %s = %q", input, value)
		}
	}
	for _, input := range []string{`true`, `{}`, `[]`} {
		var value agentID
		if err := json.Unmarshal([]byte(input), &value); err == nil {
			t.Fatalf("expected %s to be rejected", input)
		}
	}
}

func TestBuildAgentSkillPackageZip(t *testing.T) {
	data, err := buildAgentSkillPackageZip("https://example.test/")
	if err != nil {
		t.Fatal(err)
	}
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]bool{
		"petrichor/SKILL.md": false, "petrichor/config.json": false,
		"petrichor/skills/setup.md": false, "petrichor/skills/articles.md": false,
		"petrichor/skills/docs.md": false, "petrichor/skills/qa.md": false,
		"petrichor/skills/share.md": false, "petrichor/skills/ai.md": false,
		"petrichor/skills/wiki.md": false, "petrichor/scripts/petrichor": false,
		"petrichor/scripts/petrichor-api.sh": false,
		"petrichor/references/endpoints.md":  false, "petrichor/assets/manifest.json": false,
	}
	for _, file := range reader.File {
		if _, ok := expected[file.Name]; ok {
			expected[file.Name] = true
		}
		if file.Name == "petrichor/assets/manifest.json" {
			stream, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			content, err := io.ReadAll(stream)
			_ = stream.Close()
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(content), `"baseUrl": "https://example.test"`) {
				t.Fatalf("manifest base URL mismatch: %s", content)
			}
		}
	}
	for name, found := range expected {
		if !found {
			t.Errorf("missing zip entry %s", name)
		}
	}
}

func TestTruncateAgentRunesPreservesUTF8(t *testing.T) {
	if got := truncateAgentRunes("你好世界", 3); got != "你好…" {
		t.Fatalf("unexpected truncated text %q", got)
	}
	if got := summarizeAgentMarkdown("你好 世界", 3); got != "你好 …" {
		t.Fatalf("unexpected summary %q", got)
	}
}

func TestExtractAgentMediaReferences(t *testing.T) {
	refs := extractAgentMediaReferences(
		`![封面](s4key:uploads/7/cover.png) [附件](uploads/7/spec.icls) <video src="https://cdn.example.test/demo.mp4"></video>`,
		nil,
		nil,
	)
	if len(refs) != 3 {
		t.Fatalf("media count = %d: %#v", len(refs), refs)
	}
	if refs[0].Kind != "image" || refs[0].ObjectKey == nil || *refs[0].ObjectKey != "uploads/7/cover.png" {
		t.Fatalf("unexpected image ref %#v", refs[0])
	}
	if refs[1].Kind != "file" || refs[1].Filename != "spec.icls" {
		t.Fatalf("unexpected file ref %#v", refs[1])
	}
	if refs[2].Kind != "video" {
		t.Fatalf("unexpected video ref %#v", refs[2])
	}
}

func TestExtractAgentStorageObjectKeys(t *testing.T) {
	contentJSON := `{"src":"s4key:uploads/7/from-json.bin","other":"s4key:uploads/8/not-owned.bin"}`
	keys := extractAgentStorageObjectKeys(
		`![a](s4key:uploads/7/a.png) ![again](s4key:uploads/7/a.png)`,
		&contentJSON,
		7,
	)
	if strings.Join(keys, ",") != "uploads/7/a.png,uploads/7/from-json.bin" {
		t.Fatalf("unexpected object keys %#v", keys)
	}
}
