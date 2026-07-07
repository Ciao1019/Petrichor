import { describe, expect, it } from "vitest"
import {
    DISTILL_MIN_INTERVAL_MS,
    DISTILL_MIN_NEW_MESSAGES,
    MAX_DISTILLED_PER_RUN,
    MAX_PROMPT_MEMORIES,
    buildMemoryPromptSection,
    buildObserverUserMessage,
    buildReflectorUserMessage,
    normalizeMemoryContent,
    parseDistilledMemories,
    shouldDistillAgentMemory,
} from "./agent-memory-logic"

const NOW = new Date("2026-07-02T12:00:00.000Z")

describe("shouldDistillAgentMemory", () => {
    it("新消息不足时不蒸馏", () => {
        expect(shouldDistillAgentMemory({
            lastDistilledAt: null,
            newUserMessageCount: DISTILL_MIN_NEW_MESSAGES - 1,
            now: NOW,
        })).toBe(false)
    })

    it("从未蒸馏且消息足够时触发", () => {
        expect(shouldDistillAgentMemory({
            lastDistilledAt: null,
            newUserMessageCount: DISTILL_MIN_NEW_MESSAGES,
            now: NOW,
        })).toBe(true)
    })

    it("距上次蒸馏不足 12 小时时限频", () => {
        expect(shouldDistillAgentMemory({
            lastDistilledAt: new Date(NOW.getTime() - DISTILL_MIN_INTERVAL_MS + 60_000),
            newUserMessageCount: 20,
            now: NOW,
        })).toBe(false)
        expect(shouldDistillAgentMemory({
            lastDistilledAt: new Date(NOW.getTime() - DISTILL_MIN_INTERVAL_MS),
            newUserMessageCount: 20,
            now: NOW,
        })).toBe(true)
    })
})

describe("parseDistilledMemories", () => {
    it("解析合法条目并归一化 kind", () => {
        const items = parseDistilledMemories(JSON.stringify([
            { kind: "preference", content: "用户偏好简洁的中文回答" },
            { kind: "TOPIC", content: "用户经常询问 Rust 所有权相关问题" },
        ]))
        expect(items).toHaveLength(2)
        expect(items[0].kind).toBe("PREFERENCE")
        expect(items[1].kind).toBe("TOPIC")
    })

    it("剥掉代码块围栏并跳过非法条目", () => {
        const items = parseDistilledMemories("```json\n" + JSON.stringify([
            { kind: "FACT", content: "用户在维护一个 Next.js 开源项目" },
            { kind: "GUESS", content: "非法 kind" },
            { kind: "TOPIC", content: "" },
        ]) + "\n```")
        expect(items).toHaveLength(1)
        expect(items[0].kind).toBe("FACT")
    })

    it("按归一化内容去重并限制条数", () => {
        const many = Array.from({ length: MAX_DISTILLED_PER_RUN + 4 }, (_, index) => ({
            kind: "TOPIC",
            content: `用户关注主题 ${index}`,
        }))
        expect(parseDistilledMemories(JSON.stringify(many))).toHaveLength(MAX_DISTILLED_PER_RUN)

        const dup = parseDistilledMemories(JSON.stringify([
            { kind: "TOPIC", content: "用户关注 pgvector 检索" },
            { kind: "TOPIC", content: "用户关注 pgvector 检索。" },
        ]))
        expect(dup).toHaveLength(1)
    })

    it("非 JSON 或非数组时返回空数组而非抛错", () => {
        expect(parseDistilledMemories("不是 JSON")).toEqual([])
        expect(parseDistilledMemories("{\"kind\":\"TOPIC\"}")).toEqual([])
    })
})

describe("buildMemoryPromptSection", () => {
    it("无可用记忆时返回 null", () => {
        expect(buildMemoryPromptSection([])).toBeNull()
        expect(buildMemoryPromptSection([{ kind: "UNKNOWN", content: "x" }])).toBeNull()
    })

    it("按 kind 标注并附带使用规则", () => {
        const section = buildMemoryPromptSection([
            { kind: "PREFERENCE", content: "用户偏好带引用的回答" },
            { kind: "TOPIC", content: "用户经常研究 MCP 协议" },
        ])
        expect(section).toContain("[偏好] 用户偏好带引用的回答")
        expect(section).toContain("[常关注] 用户经常研究 MCP 协议")
        expect(section).toContain("以本次问题与检索到的文档为准")
    })

    it("最多注入 MAX_PROMPT_MEMORIES 条", () => {
        const memories = Array.from({ length: MAX_PROMPT_MEMORIES + 5 }, (_, index) => ({
            kind: "TOPIC",
            content: `主题 ${index}`,
        }))
        const section = buildMemoryPromptSection(memories) ?? ""
        expect(section.match(/- \[/g)).toHaveLength(MAX_PROMPT_MEMORIES)
    })
})

describe("buildObserverUserMessage", () => {
    it("按时间升序列出对话双方消息并标注 User/Agent", () => {
        const message = buildObserverUserMessage([
            { role: "user", text: "第一个问题" },
            { role: "assistant", text: "第一个回答" },
        ])
        expect(message).toContain("User: 第一个问题")
        expect(message).toContain("Agent: 第一个回答")
    })
})

describe("buildReflectorUserMessage", () => {
    it("编号列出现有观察并带 kind 标签", () => {
        const message = buildReflectorUserMessage([
            { kind: "PREFERENCE", content: "用户偏好带引用的回答" },
            { kind: "TOPIC", content: "用户经常研究 MCP 协议" },
        ])
        expect(message).toContain("1. [偏好] 用户偏好带引用的回答")
        expect(message).toContain("2. [常关注] 用户经常研究 MCP 协议")
    })
})

describe("normalizeMemoryContent", () => {
    it("忽略空白、标点与大小写差异", () => {
        expect(normalizeMemoryContent("用户偏好 简洁回答。"))
            .toBe(normalizeMemoryContent("用户偏好简洁回答"))
        expect(normalizeMemoryContent("User prefers MCP"))
            .toBe(normalizeMemoryContent("user prefers mcp"))
    })
})
