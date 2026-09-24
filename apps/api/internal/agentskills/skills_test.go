package agentskills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseAndLoad(t *testing.T) {
	text := "---\nname: research-note\ndescription: 整理资料\nmetadata:\n  petrichor:\n    tools: [knowledge.read]\n    dependencies: [knowledge]\n---\n先读取来源。\n"
	d, err := Parse([]byte(strings.ReplaceAll(text, "\n", "\r\n")))
	if err != nil || d.Instructions != "先读取来源。" || d.Target != "assistant" || len(d.Tools) != 1 {
		t.Fatalf("%+v %v", d, err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir, "")
	if err != nil || len(loaded) != 1 {
		t.Fatalf("%+v %v", loaded, err)
	}
	if err := os.Symlink(filepath.Join(dir, "SKILL.md"), filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(dir, ""); err == nil {
		t.Fatal("接受了符号链接")
	}
}

func TestRejectMalformedAndDocumentTools(t *testing.T) {
	for _, text := range []string{"missing", "---\nname: a\n---\n正文", "---\nname: ../bad\ndescription: x\n---\nx", "---\nname: a\ndescription: x\nmetadata:\n  petrichor:\n    target: document\n    tools: [bash]\n---\nx"} {
		if _, err := Parse([]byte(text)); err == nil {
			t.Fatalf("接受非法技能 %q", text)
		}
	}
}
