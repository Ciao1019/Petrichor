import {
    ADMIN_SKILL_PROMPT,
    DOCUMENTS_SKILL_PROMPT,
    GRAPH_SKILL_PROMPT,
    KNOWLEDGE_SKILL_PROMPT,
    MEMORY_SKILL_PROMPT,
    RESEARCH_SKILL_PROMPT,
    SYSTEM_SKILL_PROMPT,
    WRITER_SKILL_PROMPT,
} from "./prompts/skills"
import { PERMISSIONS } from "./permissions"
import type { AgentSkill } from "./types"

/**
 * Skill 注册表（§14/§16/§153）。
 *
 * Skill = 一组工具 + 一段操作说明。它只扩大"模型可见能力"，不改变用户真实权限（§149）。
 * 默认只把简短能力目录写进 system prompt，正文经 agent.load_skill 注入。
 */
export class AgentSkillRegistry {
    private readonly skills = new Map<string, AgentSkill>()

    register(skill: AgentSkill): void {
        this.skills.set(skill.id, skill)
    }

    registerMany(skills: AgentSkill[]): void {
        for (const skill of skills) this.register(skill)
    }

    get(id: string): AgentSkill | null {
        return this.skills.get(id) ?? null
    }

    has(id: string): boolean {
        return this.skills.has(id)
    }

    list(): AgentSkill[] {
        return [...this.skills.values()]
    }

    get ids(): string[] {
        return [...this.skills.keys()]
    }

    /** 解析依赖链，返回按依赖优先的加载顺序；自动去环 */
    resolveWithDependencies(id: string, seen = new Set<string>()): AgentSkill[] {
        if (seen.has(id)) return []
        const skill = this.skills.get(id)
        if (!skill) return []
        seen.add(id)
        const result: AgentSkill[] = []
        for (const dependency of skill.dependencies ?? []) {
            result.push(...this.resolveWithDependencies(dependency, seen))
        }
        result.push(skill)
        return result
    }

    clear(): void {
        this.skills.clear()
    }
}

export const agentSkillRegistry = new AgentSkillRegistry()

/** 内置技能定义。toolIds 引用 tool-registry 中的工具 id。 */
export const BUILTIN_SKILLS: AgentSkill[] = [
    {
        id: "knowledge",
        name: "知识库",
        description: "检索并深读站内知识库内容",
        instructions: KNOWLEDGE_SKILL_PROMPT,
        toolIds: [
            "knowledge.lookup",
            "knowledge.search",
            "knowledge.read_many",
            "knowledge.read",
            "knowledge.list_bases",
        ],
        tags: ["retrieval"],
    },
    {
        id: "graph",
        name: "知识图谱",
        description: "实体关系、依赖与关联文章的图谱查询",
        instructions: GRAPH_SKILL_PROMPT,
        toolIds: ["graph.search", "graph.expand", "graph.get_entity", "graph.get_relations"],
        dependencies: ["knowledge"],
        tags: ["retrieval"],
    },
    {
        id: "research",
        name: "外部研究",
        description: "搜索与阅读站外公开资料",
        instructions: RESEARCH_SKILL_PROMPT,
        toolIds: ["research.search", "research.fetch", "research.extract"],
        tags: ["external"],
    },
    {
        id: "memory",
        name: "长期记忆",
        description: "跨会话的长期记忆检索与维护",
        instructions: MEMORY_SKILL_PROMPT,
        toolIds: ["memory.search", "memory.write", "memory.update", "memory.delete"],
        permissions: [PERMISSIONS.memoryWrite],
        tags: ["memory"],
    },
    {
        id: "writer",
        name: "写作",
        description: "长文撰写、改写、归纳与结构梳理",
        instructions: WRITER_SKILL_PROMPT,
        toolIds: [
            "writer.compose",
            "writer.rewrite",
            "writer.summarize",
            "writer.structure",
            "writer.save_artifact",
        ],
        tags: ["generation"],
    },
    {
        id: "documents",
        name: "文档库",
        description: "文档检索、阅读与增改导出",
        instructions: DOCUMENTS_SKILL_PROMPT,
        toolIds: [
            "document.search",
            "document.read",
            "document.create",
            "document.update",
            "document.move",
            "document.preview_update",
            "document.share",
            "document.list_libraries",
            // 危险操作只能经确认卡发起，删除类工具本身不对模型暴露
            "agent.request_confirmation",
        ],
        permissions: [PERMISSIONS.write],
        tags: ["document"],
    },
    {
        id: "admin",
        name: "管理",
        description: "模型配置、API Key 与站点开关等管理操作",
        instructions: ADMIN_SKILL_PROMPT,
        toolIds: [
            "admin.list_models",
            "admin.bind_model",
            "admin.list_api_keys",
            "admin.get_public_qa",
        ],
        permissions: [PERMISSIONS.admin],
        tags: ["admin"],
    },
    {
        id: "system",
        name: "站点概览",
        description: "系统与资源清单概览",
        instructions: SYSTEM_SKILL_PROMPT,
        toolIds: ["system.overview"],
        tags: ["system"],
    },
]

agentSkillRegistry.registerMany(BUILTIN_SKILLS)

/** 能力目录（§16）：只给一行描述，不给完整 instructions */
export function renderSkillCatalog(skills: AgentSkill[]): string {
    if (skills.length === 0) return ""
    const lines = skills.map((skill) => `- ${skill.id}: ${skill.description}`)
    return `可加载的能力（用 agent.load_skill 加载）：\n${lines.join("\n")}`
}
