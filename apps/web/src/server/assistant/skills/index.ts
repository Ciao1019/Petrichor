import { createSkill, type InlineSkill } from "@mastra/core/skills"
import type { AgentDomainId } from "../domain-types"

const knowledgeQa = createSkill({
    name: "knowledge-qa",
    description:
        "Use when the user asks about knowledge bases, wiki/articles, or needs citations. 用户查知识库、核对文章事实、要引用时使用。",
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
})

const docLibraryQa = createSkill({
    name: "doc-library-qa",
    description:
        "Use when the user asks about document libraries, PDFs, or file excerpts. 用户查文档库、要文档片段定位时使用。",
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
})

const articleWrite = createSkill({
    name: "article-write",
    description:
        "Use when creating/updating/deleting articles or managing share links. 用户写改文章、分享或危险删除时使用。",
    instructions: `
## 内容写入流程

1. 普通写入用 create_article / update_article / create_article_share。
2. 复杂写入可先 spawn_write_subagent 规划；根据 summary/proposedActions 执行。
3. 删除文章、撤销分享、删除文档属于危险操作：
   - 必须调用 request_user_confirmation（action.toolName 填 delete_article / revoke_article_share / delete_document）
   - 禁止假装已删除；等用户确认后运行时会给出 executionOutcome。
4. 不要让子代理直接执行 risk=dangerous 的写操作。
`.trim(),
})

const adminOps = createSkill({
    name: "admin-ops",
    description:
        "Use when managing AI configs, agent API keys, or public QA settings. 用户查看或修改模型配置/密钥/公开问答时使用。",
    instructions: `
## 管理面流程

1. 查询：list_ai_configs / list_agent_api_keys / get_public_qa_setting。
2. 设置默认模型：set_default_ai_config 可直接执行。
3. 危险操作必须 request_user_confirmation：
   - delete_ai_config
   - update_ai_config_credentials
   - revoke_agent_api_key
   - set_public_qa_enabled
4. 公开问答开关仅超级管理员可改；权限不足时如实说明。
`.trim(),
})

const DOMAIN_SKILLS: Partial<Record<AgentDomainId, InlineSkill[]>> = {
    knowledge: [knowledgeQa],
    doc_library: [docLibraryQa],
    content_write: [articleWrite],
    admin: [adminOps],
}

/** 按本轮路由域挂载相关 playbook；system 域不单独挂 skill（进度/引用由 system prompt + 工具承担） */
export function resolveAssistantSkills(domains: AgentDomainId[]): InlineSkill[] {
    const seen = new Set<string>()
    const skills: InlineSkill[] = []
    for (const domain of domains) {
        for (const skill of DOMAIN_SKILLS[domain] ?? []) {
            if (seen.has(skill.name)) continue
            seen.add(skill.name)
            skills.push(skill)
        }
    }
    return skills
}

export const ASSISTANT_SKILL_NAMES = {
    knowledgeQa: knowledgeQa.name,
    docLibraryQa: docLibraryQa.name,
    articleWrite: articleWrite.name,
    adminOps: adminOps.name,
} as const
