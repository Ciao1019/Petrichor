import type { AssistantPersistedPlan, AssistantThreadMessage } from "@/lib/api"

import type { DemoHandlerResult } from "./demo-adapter"
import { demoStore, type DemoThread } from "./demo-store"

/*
 * 演示模式的助手线程存储与 axios handlers。
 * 对话流本身由 demo-chat.ts 以脚本回放生成，这里负责线程列表 / 详情 /
 * 删除 / Plan 勾选等「壳」接口，并把回放产生的消息持久化进内存，
 * 让「切走再切回来」的体验与真实后端一致。
 */

let threadSeq = 0
let messageSeq = 0
let seeded = false

function nowIso() {
    return new Date().toISOString()
}

function makeMessage(role: "user" | "assistant", parts: unknown[]): AssistantThreadMessage {
    messageSeq += 1
    return {
        id: `demo-msg-${messageSeq}`,
        role,
        content: { parts },
        createdAt: nowIso(),
    }
}

function textPart(text: string) {
    return { type: "text", text }
}

/** 预置一段历史对话，让线程列表 / 仪表盘「最近对话」不空。 */
export function ensureDemoThreads() {
    if (seeded) return
    seeded = true
    const createdAt = new Date(Date.now() - 26 * 3600 * 1000).toISOString()
    const thread: DemoThread = {
        summary: {
            id: "demo-thread-seed-1",
            title: "盘点三个知识库的现状",
            focus: null,
            createdAt,
            updatedAt: createdAt,
        },
        messages: [
            makeMessage("user", [textPart("我现在有多少个知识库？各自在写什么？")]),
            makeMessage("assistant", [
                textPart(
                    "你目前有 **3 个知识库**：\n\n" +
                    "1. **开源命令行工具手册** —— Mole 与 Fastfetch 的完整使用文档，包含安装、配置和安全注意事项\n" +
                    "2. **前端工程笔记** —— React / TypeScript / 构建优化的日常沉淀\n" +
                    "3. **读书摘录** —— 非虚构读书笔记，按书拆篇\n\n" +
                    "工具手册更新最勤，已经同步编译成可检索、可回链来源的 Wiki 页面。",
                ),
            ]),
        ],
        plans: [],
    }
    demoStore.threads.unshift(thread)
}

export function findThread(threadId: string) {
    ensureDemoThreads()
    return demoStore.threads.find((thread) => thread.summary.id === threadId) ?? null
}

/** 回放开始时由 demo-chat 调用：取到（或建出）线程并追加用户消息。 */
export function beginDemoExchange(threadId: string | null, userText: string): DemoThread {
    ensureDemoThreads()
    let thread = threadId ? findThread(threadId) : null
    if (!thread) {
        threadSeq += 1
        thread = {
            summary: {
                id: `demo-thread-${threadSeq}`,
                title: userText.slice(0, 24) || "新的对话",
                focus: null,
                createdAt: nowIso(),
                updatedAt: nowIso(),
            },
            messages: [],
            plans: [],
        }
        demoStore.threads.unshift(thread)
    }
    thread.messages.push(makeMessage("user", [textPart(userText)]))
    thread.summary.updatedAt = nowIso()
    return thread
}

/** 回放结束时把助手侧 parts 与 Plan 落进线程。 */
export function completeDemoExchange(thread: DemoThread, assistantParts: unknown[], plan?: AssistantPersistedPlan) {
    thread.messages.push(makeMessage("assistant", assistantParts))
    if (plan) {
        const index = thread.plans.findIndex((item) => item.id === plan.id)
        if (index >= 0) thread.plans[index] = plan
        else thread.plans.push(plan)
    }
    thread.summary.updatedAt = nowIso()
}

/* ---------- axios handlers ---------- */

function str(value: unknown): string {
    return typeof value === "string" ? value : ""
}

export function demoThreadList(body: Record<string, unknown>): DemoHandlerResult {
    ensureDemoThreads()
    const keyword = str(body.q).trim().toLowerCase()
    const items = demoStore.threads
        .map((thread) => thread.summary)
        .filter((summary) => !keyword || summary.title.toLowerCase().includes(keyword))
    return { data: { items, nextCursor: null } }
}

export function demoThreadDetail(body: Record<string, unknown>): DemoHandlerResult {
    const thread = findThread(str(body.threadId))
    if (!thread) return { status: 404, data: { code: 404, msg: "对话不存在" } }
    return {
        data: {
            thread: thread.summary,
            messages: thread.messages,
            plans: thread.plans,
        },
    }
}

export function demoThreadDelete(threadIds: string[]): DemoHandlerResult {
    ensureDemoThreads()
    const remove = new Set(threadIds)
    const before = demoStore.threads.length
    demoStore.threads = demoStore.threads.filter((thread) => !remove.has(thread.summary.id))
    return { data: { ok: true, deleted: before - demoStore.threads.length } }
}

export function demoPlanPatch(body: Record<string, unknown>): DemoHandlerResult {
    const thread = findThread(str(body.threadId))
    const plan = thread?.plans.find((item) => item.id === str(body.planId))
    if (!thread || !plan) return { status: 404, data: { code: 404, msg: "计划不存在" } }
    const todo = plan.todos.find((item) => item.id === str(body.todoId))
    if (todo) {
        const status = str(body.status)
        if (status === "pending" || status === "in_progress" || status === "completed" || status === "cancelled") {
            todo.status = status
        }
    }
    return { data: { plan } }
}
