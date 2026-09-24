package assistantsvc

import (
	"os"
	"path/filepath"
	"testing"

	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/config"
)

func TestFileSkillsValidateBeforeRegistration(t *testing.T) {
	for _, tc := range []struct {
		name, tools, deps string
		valid             bool
	}{
		{"custom", "[knowledge.read]", "[knowledge]", true},
		{"unknown", "[fake.tool]", "[]", false},
		{"cycle", "[]", "[cycle]", false},
		{"knowledge", "[]", "[]", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			body := "---\nname: " + tc.name + "\ndescription: 自定义\nmetadata:\n  petrichor:\n    tools: " + tc.tools + "\n    dependencies: " + tc.deps + "\n---\n先核对来源。"
			if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0600); err != nil {
				t.Fatal(err)
			}
			tools, skills := rt.NewToolRegistry(), rt.NewSkillRegistry()
			RegisterAssistantTools(tools, skills)
			err := loadAssistantSkills(tools, skills, &config.Config{Agent: config.AgentConfig{SkillsDirectory: dir}})
			if (err == nil) != tc.valid {
				t.Fatalf("%v", err)
			}
			if tc.valid && skills.Get(tc.name) == nil {
				t.Fatal("未注册文件技能")
			}
		})
	}
}
