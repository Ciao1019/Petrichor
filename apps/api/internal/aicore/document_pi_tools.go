package aicore

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"petrichor/api/internal/piruntime"
)

func documentPiTools(child bool) []piruntime.Tool {
	definitions := []struct{ name, description, schema string }{
		{"read_file", "读取虚拟工作区文件，offset 从 1 开始，limit 为行数；省略范围读取全文", `{"type":"object","properties":{"file_path":{"type":"string"},"offset":{"type":"integer","minimum":1},"limit":{"type":"integer","minimum":1}},"required":["file_path"]}`},
		{"ls", "列出虚拟目录下的文件", `{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}`},
		{"glob", "按 glob 匹配虚拟文件路径", `{"type":"object","properties":{"pattern":{"type":"string"}},"required":["pattern"]}`},
		{"grep", "按正则表达式检索工作区文件，检索命中不算全文读取", `{"type":"object","properties":{"pattern":{"type":"string"},"path":{"type":"string"}},"required":["pattern"]}`},
		{"write_file", "保存阶段结果到 /work/；只有主 Agent 可以写 /output/result.json。正文和知识库索引只读", `{"type":"object","properties":{"file_path":{"type":"string"},"content":{"type":"string"}},"required":["file_path","content"]}`},
		{"edit_file", "精确替换可写文件中的文本", `{"type":"object","properties":{"file_path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"}},"required":["file_path","old_string","new_string"]}`},
		{"write_todos", "记录文档分析待办计划", `{"type":"object","properties":{"todos":{"type":"array","items":{"type":"object","properties":{"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"]}},"required":["content","status"]}}},"required":["todos"]}`},
	}
	if !child {
		definitions = append(definitions, struct{ name, description, schema string }{
			"task", "委派分卷分析；description 执行单任务，tasks 执行最多 3 个并行任务。子 Agent 只能读取来源、写 /work/，不能递归或提交最终结果",
			`{"type":"object","properties":{"description":{"type":"string"},"subagent_type":{"type":"string"},"tasks":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","properties":{"description":{"type":"string"}},"required":["description"]}}}}`,
		})
	}
	tools := make([]piruntime.Tool, 0, len(definitions))
	for _, item := range definitions {
		tools = append(tools, piruntime.Tool{Name: item.name, Description: item.description, Parameters: json.RawMessage(item.schema)})
	}
	return tools
}

func executeDocumentWorkspaceTool(ctx context.Context, backend *trackedDocumentBackend, call piruntime.ToolCall, child bool) (string, error) {
	var args map[string]any
	if json.Unmarshal([]byte(call.Arguments), &args) != nil {
		return "", fmt.Errorf("工具参数必须是 JSON 对象")
	}
	filePath := firstDocumentAgentString(args, "file_path", "path")
	files := backend.snapshot()
	switch call.Name {
	case "read_file":
		if filePath == "" {
			return "", fmt.Errorf("缺少文件路径")
		}
		result, err := backend.Read(ctx, &documentReadRequest{FilePath: filePath, Offset: documentAgentInt(args["offset"]), Limit: documentAgentInt(args["limit"])})
		if err != nil {
			return "", err
		}
		return result.Content, nil
	case "ls", "glob", "grep":
		return searchDocumentWorkspace(files, call.Name, filePath, firstDocumentAgentString(args, "pattern"))
	case "write_file", "edit_file":
		filePath = normalizeDocumentAgentPath(filePath)
		if !strings.HasPrefix(filePath, "/work/") && (child || filePath != documentAgentResultPath) {
			return "", fmt.Errorf("该工作区路径只读或未授权")
		}
		content, ok := args["content"].(string)
		if call.Name == "edit_file" {
			old, oldOK := args["old_string"].(string)
			replacement, newOK := args["new_string"].(string)
			current, exists := files[filePath]
			if !exists || !oldOK || !newOK || old == "" || strings.Count(current, old) != 1 {
				return "", fmt.Errorf("待替换文本必须在已有文件中唯一匹配")
			}
			content, ok = strings.Replace(current, old, replacement, 1), true
		}
		if !ok {
			return "", fmt.Errorf("缺少文件内容")
		}
		if err := backend.Write(ctx, &documentWriteRequest{FilePath: filePath, Content: content}); err != nil {
			return "", err
		}
		return "文件已保存", nil
	case "write_todos":
		if _, ok := args["todos"].([]any); !ok {
			return "", fmt.Errorf("缺少待办数组")
		}
		content, err := json.Marshal(args["todos"])
		if err != nil {
			return "", err
		}
		if err := backend.Write(ctx, &documentWriteRequest{FilePath: "/work/todos.json", Content: string(content)}); err != nil {
			return "", err
		}
		return "执行计划已保存至 /work/todos.json", nil
	default:
		return "", fmt.Errorf("未授权的文档工具")
	}
}

func searchDocumentWorkspace(files map[string]string, name, prefix, pattern string) (string, error) {
	paths := make([]string, 0, len(files))
	for file := range files {
		paths = append(paths, file)
	}
	sort.Strings(paths)
	var expression *regexp.Regexp
	var err error
	if name == "grep" {
		if pattern == "" {
			return "", fmt.Errorf("缺少检索表达式")
		}
		expression, err = regexp.Compile(pattern)
		if err != nil {
			return "", fmt.Errorf("检索正则表达式无效")
		}
	}
	if prefix == "" {
		prefix = "/"
	} else {
		prefix = normalizeDocumentAgentPath(prefix)
	}
	var matches []string
	length := 0
	for _, file := range paths {
		if name == "glob" {
			match, err := path.Match(pattern, file)
			if err != nil {
				return "", fmt.Errorf("glob 表达式无效")
			}
			if !match {
				continue
			}
		} else if file != prefix && !strings.HasPrefix(file, strings.TrimRight(prefix, "/")+"/") {
			continue
		}
		if expression == nil {
			matches = append(matches, file)
			length += len(file)
		} else {
			for number, line := range strings.Split(files[file], "\n") {
				if expression.MatchString(line) {
					if len([]rune(line)) > 1500 {
						line = string([]rune(line)[:1500]) + "…[请用 read_file 深读]"
					}
					value := fmt.Sprintf("%s:%d:%s", file, number+1, line)
					matches = append(matches, value)
					length += len(value)
				}
				if len(matches) >= 100 || length > 30_000 {
					break
				}
			}
		}
		if len(matches) >= 100 || length > 30_000 {
			matches = append(matches, "[结果已截断，请缩小检索范围]")
			break
		}
	}
	return strings.Join(matches, "\n"), nil
}
