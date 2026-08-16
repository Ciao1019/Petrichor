import type { AgentDomainId } from "../domain-types"

export type AssistantSkillDefinition = {
    name: string
    description: string
    instructions: string
    domains: AgentDomainId[]
}

const knowledgeQa: AssistantSkillDefinition = {
    name: "knowledge-qa",
    description: "知识库/文章问答与引用",
    domains: ["knowledge"],
    instructions: `
## 知识库问答流程

1. 优先沿用当前 focus 的知识库范围；用户明确要求跨库时再放开。
2. 问「有多少知识库/文章」等计数或清单：优先 list_system_overview / list_knowledge_bases，不要对每个库调用 search_knowledge。
3. 查内容：先调用 search_knowledge 定位节点；跨库时优先一次不传 knowledgeBaseId；根据 hits 再调用 read_knowledge_node 深读。
4. 最终答案必须基于工具返回内容；调用 show_citations，href/title/domain/snippet 直接来自检索/读取结果，禁止编造。
5. 需要图片时，在答案中用 Markdown \`![说明](src)\`，src 使用 media.src 原值（常为 s4key:…）。
6. 检索不到就如实说明，不要编造原文。
7. 多步任务用 show_progress 或 upsert_plan 更新侧栏进度，不要在正文重复罗列步骤。
`.trim(),
}

const docLibraryQa: AssistantSkillDefinition = {
    name: "doc-library-qa",
    description: "文档库检索与片段定位",
    domains: ["doc_library"],
    instructions: `
## 文档库问答流程

1. 优先沿用当前 focus 的文档库范围。
2. 问「有多少文档/文档库」等计数或清单：优先 list_system_overview / list_doc_libraries，不要对每个库重复同类 search_documents。
3. 查内容：先调用 search_documents 获取带定位的片段。
4. 上下文不足时调用 read_document，并用 fromIndex 继续翻页。
5. 最终答案基于工具结果；调用 show_citations，字段直接来自检索/读取结果。
6. 需要结构化展示时可用 show_data_table；不要编造单元格数据。
7. 多步任务用 show_progress / upsert_plan 更新侧栏进度。
`.trim(),
}

const articleWrite: AssistantSkillDefinition = {
    name: "article-write",
    description: "写改/移动文章、分享与危险删除",
    domains: ["content_write"],
    instructions: `
## 内容写入流程

1. 普通写入用 create_article / update_article / create_article_share。
2. 大段改写正文前先 preview_article_update 看 diff，再 update_article 落库。
3. 跨知识库或同库内移动文章用 move_article（必填 targetKnowledgeBaseId；parentId 不传则放到目标库根目录）。
4. 复杂写入可先 spawn_write_subagent 规划；根据 summary/proposedActions 执行。
5. 删除文章、撤销分享、删除文档属于危险操作：
   - 必须调用 request_user_confirmation（action.toolName 填 delete_article / revoke_article_share / delete_document）
   - 禁止假装已删除；等用户确认后运行时会给出 executionOutcome。
6. 两步及以上写改必须 upsert_plan，每完成一步更新 status。
7. 不要让子代理直接执行 risk=dangerous 的写操作。
`.trim(),
}

const adminOps: AssistantSkillDefinition = {
    name: "admin-ops",
    description: "模型配置 / API Key / 公开问答",
    domains: ["admin"],
    instructions: `
## 管理面流程

1. 查询：list_ai_models / list_agent_api_keys / get_public_qa_setting。
2. 绑定用途模型：bind_ai_model 可直接执行（purpose + modelRefId）。
3. 危险操作必须 request_user_confirmation：
   - delete_ai_provider
   - update_ai_credential
   - revoke_agent_api_key
   - set_public_qa_enabled
4. 公开问答开关仅超级管理员可改；权限不足时如实说明。
`.trim(),
}

export const ASSISTANT_SKILLS: AssistantSkillDefinition[] = [
    knowledgeQa,
    docLibraryQa,
    articleWrite,
    adminOps,
]

const SKILL_BY_NAME = new Map(ASSISTANT_SKILLS.map((skill) => [skill.name, skill]))

export function listAssistantSkillCatalog(domains: AgentDomainId[]): Array<{ name: string; description: string }> {
    const domainSet = new Set(domains)
    const seen = new Set<string>()
    const catalog: Array<{ name: string; description: string }> = []
    for (const skill of ASSISTANT_SKILLS) {
        if (seen.has(skill.name)) continue
        if (!skill.domains.some((domain) => domainSet.has(domain))) continue
        seen.add(skill.name)
        catalog.push({ name: skill.name, description: skill.description })
    }
    return catalog
}

export function getAssistantSkillBody(name: string): AssistantSkillDefinition | null {
    return SKILL_BY_NAME.get(name) ?? null
}

/**
 * 渐进披露：Agent 不再挂载 InlineSkill 全文；目录写入 system prompt，正文经 load_skill。
 * 保留函数名以兼容 chat-handler 调用点，始终返回空数组。
 */
export function resolveAssistantSkills(_domains: AgentDomainId[]): [] {
    return []
}

export const ASSISTANT_SKILL_NAMES = {
    knowledgeQa: knowledgeQa.name,
    docLibraryQa: docLibraryQa.name,
    articleWrite: articleWrite.name,
    adminOps: adminOps.name,
} as const
