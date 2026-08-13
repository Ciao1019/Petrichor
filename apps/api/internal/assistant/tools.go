package assistant

import "github.com/cloudwego/eino/components/tool"

func registerAllAssistantTools() {
	registerKnowledgeTools()
	registerSystemTools()
	registerContentWriteTools()
	registerAdminTools()
	registerResearchTools()
	registerMiscTools()
}

func buildBusinessTools(domains []AgentDomainId, isOperator bool) []tool.BaseTool {
	if len(domains) == 0 {
		domains = ResolveToolLoadDomains(nil)
	}
	return loadToolsForDomains(domains, isOperator)
}

func init() {
	registerAllAssistantTools()
}
