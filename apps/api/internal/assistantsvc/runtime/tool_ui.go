package runtime

import "strings"

// toolActivityRunning 与 TS tool-ui 的运行中文案保持一致。
// tool_started 必须携带 title；否则前端在首个工具事件到达的一帧会显示 undefined。
var toolActivityRunning = map[string]string{
	"knowledge.lookup":                "正在检索并阅读知识库",
	"knowledge.search":                "正在搜索知识库",
	"knowledge.read_many":             "正在并行阅读知识章节",
	"knowledge.read":                  "正在阅读知识文档",
	"knowledge.list_bases":            "正在查看知识库列表",
	"knowledge.wiki_overview":         "正在查看 Wiki 页面目录",
	"knowledge.search_wiki_pages":     "正在搜索 Wiki 页面",
	"knowledge.read_wiki_page_detail": "正在阅读 Wiki 页面",
	"graph.search":                    "正在查询知识图谱",
	"graph.expand":                    "正在扩展关联实体",
	"graph.get_entity":                "正在读取实体信息",
	"graph.get_relations":             "正在读取实体关系",
	"research.search":                 "正在搜索外部资料",
	"research.fetch":                  "正在阅读外部来源",
	"research.extract":                "正在提取来源要点",
	"memory.search":                   "正在检索长期记忆",
	"memory.write":                    "正在保存长期记忆",
	"memory.update":                   "正在更新长期记忆",
	"memory.delete":                   "正在删除长期记忆",
	"document.search":                 "正在检索文档库",
	"document.read":                   "正在阅读文档",
	"document.create":                 "正在创建文档",
	"document.update":                 "正在更新文档",
	"document.export":                 "正在导出文档",
	"writer.compose":                  "正在整理并生成内容",
	"writer.rewrite":                  "正在改写内容",
	"writer.summarize":                "正在归纳要点",
	"writer.structure":                "正在梳理结构",
	"agent.load_skill":                "正在加载能力",
	"agent.delegate":                  "正在委派子任务",
	"system.overview":                 "正在查看系统概览",
}

var namespaceActivityRunning = map[string]string{
	"knowledge": "正在使用知识库",
	"graph":     "正在查询知识图谱",
	"research":  "正在查询外部资料",
	"memory":    "正在使用记忆",
	"document":  "正在处理文档",
	"writer":    "正在生成内容",
	"admin":     "正在执行管理操作",
	"system":    "正在分析",
	"agent":     "正在协调子任务",
}

func toolActivityTitle(toolID string, input any) string {
	title := toolActivityRunning[toolID]
	if title == "" {
		namespace := toolID
		if index := strings.IndexByte(namespace, '.'); index >= 0 {
			namespace = namespace[:index]
		}
		title = namespaceActivityRunning[namespace]
	}
	if title == "" {
		title = "正在处理"
	}
	if hint := toolActivityHint(input); hint != "" {
		return title + "：" + hint
	}
	return title
}

func toolActivityHint(input any) string {
	record, _ := input.(map[string]any)
	for _, key := range []string{"query", "objective", "goal", "title", "keyword"} {
		value, _ := record[key].(string)
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		runes := []rune(value)
		if len(runes) > 40 {
			return string(runes[:40]) + "…"
		}
		return value
	}
	return ""
}
