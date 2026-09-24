package assistantsvc

import (
	"fmt"

	"petrichor/api/internal/agentskills"
	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/internal/config"
)

func loadAssistantSkills(tools *rt.AgentToolRegistry, skills *rt.SkillRegistryImpl, cfg *config.Config) error {
	definitions, err := agentskills.Load(cfg.Agent.SkillsDirectory, cfg.Path)
	if err != nil {
		return err
	}
	pending := map[string]agentskills.Definition{}
	for _, d := range definitions {
		if d.Target != "assistant" {
			continue
		}
		if skills.Get(d.ID) != nil {
			return fmt.Errorf("文件技能不可覆盖内置技能: %s", d.ID)
		}
		for _, id := range d.Tools {
			if !tools.Has(id) {
				return fmt.Errorf("技能 %s 引用了未知工具 %s", d.ID, id)
			}
		}
		pending[d.ID] = d
	}
	state := map[string]int{}
	var visit func(string) error
	visit = func(id string) error {
		if skills.Get(id) != nil {
			return nil
		}
		d, ok := pending[id]
		if !ok {
			return fmt.Errorf("未找到依赖技能: %s", id)
		}
		if state[id] == 1 {
			return fmt.Errorf("技能依赖存在环: %s", id)
		}
		if state[id] == 2 {
			return nil
		}
		state[id] = 1
		for _, dep := range d.Dependencies {
			if err := visit(dep); err != nil {
				return err
			}
		}
		state[id] = 2
		return nil
	}
	for id := range pending {
		if err := visit(id); err != nil {
			return err
		}
	}
	for _, d := range definitions {
		if d.Target == "assistant" {
			skills.Register(rt.AgentSkill{ID: d.ID, Name: d.Name, Description: d.Description, Instructions: d.Instructions, ToolIDs: d.Tools, Deps: d.Dependencies})
		}
	}
	return nil
}

// InitializeExtensions 在开始监听前校验文件技能，避免错误配置直到聊天时才暴露。
func InitializeExtensions() error { ensureToolsRegistered(); return toolsInitError }
