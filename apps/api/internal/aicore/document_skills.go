package aicore

import (
	"strings"

	"petrichor/api/internal/agentskills"
	"petrichor/api/internal/config"
)

func documentSkillInstructions() (string, error) {
	cfg := config.Get()
	skills, err := agentskills.Load(cfg.Agent.SkillsDirectory, cfg.Path)
	if err != nil {
		return "", err
	}
	var out strings.Builder
	for _, skill := range skills {
		if skill.Target == "document" {
			out.WriteString("\n\n## 文档技能：" + skill.Name + "\n" + skill.Instructions)
		}
	}
	return out.String(), nil
}
