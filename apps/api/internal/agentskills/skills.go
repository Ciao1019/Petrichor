// Package agentskills 读取管理员维护的 SKILL.md；不执行脚本、不加载任意代码。
package agentskills

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

type Definition struct {
	ID           string
	Name         string
	Description  string
	Instructions string
	Tools        []string
	Dependencies []string
	Target       string
}

var validID = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)

// Load 路径相对 config.toml；文件顺序稳定。符号链接、过大目录和重复 ID 都拒绝。
func Load(directory, configPath string) ([]Definition, error) {
	if directory == "" {
		return nil, nil
	}
	if !filepath.IsAbs(directory) {
		directory = filepath.Join(filepath.Dir(configPath), directory)
	}
	definitions := []Definition{}
	seen := map[string]bool{}
	visited := 0
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		visited++
		if visited > 512 {
			return fmt.Errorf("技能目录超过 512 个文件/目录")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("技能目录不能包含符号链接")
		}
		if entry.IsDir() || entry.Name() != "SKILL.md" {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || info.Size() > 64*1024 {
			return fmt.Errorf("SKILL.md 必须为不超过 64 KiB 的普通文件")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		d, err := Parse(data)
		if err != nil {
			return fmt.Errorf("技能 %s: %w", filepath.Base(filepath.Dir(path)), err)
		}
		if seen[d.ID] {
			return fmt.Errorf("重复技能 ID: %s", d.ID)
		}
		seen[d.ID] = true
		definitions = append(definitions, d)
		if len(definitions) > 64 {
			return fmt.Errorf("最多加载 64 个技能")
		}
		return nil
	})
	return definitions, err
}

// 标准 name/description + metadata.petrichor 扩展，不把第三方 SKILL 当可执行插件。
func Parse(data []byte) (Definition, error) {
	d := Definition{}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return d, fmt.Errorf("缺少 YAML frontmatter")
	}
	end := strings.Index(text[4:], "\n---\n")
	if end < 0 {
		return d, fmt.Errorf("frontmatter 未闭合")
	}
	var header struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
		Metadata    struct {
			Petrichor struct {
				Title        string   `yaml:"title"`
				Target       string   `yaml:"target"`
				Tools        []string `yaml:"tools"`
				Dependencies []string `yaml:"dependencies"`
			} `yaml:"petrichor"`
		} `yaml:"metadata"`
	}
	decoder := yaml.NewDecoder(bytes.NewBufferString(text[4 : 4+end]))
	if err := decoder.Decode(&header); err != nil {
		return d, fmt.Errorf("frontmatter 无效")
	}
	meta := header.Metadata.Petrichor
	d = Definition{ID: header.Name, Name: meta.Title, Description: strings.TrimSpace(header.Description),
		Instructions: strings.TrimSpace(text[4+end+5:]), Tools: meta.Tools, Dependencies: meta.Dependencies, Target: meta.Target}
	if d.Name == "" {
		d.Name = d.ID
	}
	if d.Target == "" {
		d.Target = "assistant"
	}
	if !validID.MatchString(d.ID) || d.Description == "" || len(d.Description) > 2000 || d.Instructions == "" {
		return d, fmt.Errorf("技能 name、description 或正文无效")
	}
	if d.Target != "assistant" && d.Target != "document" {
		return d, fmt.Errorf("target 只支持 assistant/document")
	}
	if d.Target == "document" && (len(d.Tools) > 0 || len(d.Dependencies) > 0) {
		return d, fmt.Errorf("文档技能仅提供规则，沿用文档 Agent 的受限工具")
	}
	return d, nil
}
