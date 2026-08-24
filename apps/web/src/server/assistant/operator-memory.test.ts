import { beforeEach, describe, expect, it, vi } from "vitest"
import {
    OPERATOR_AGENT_NOTES_MAX_CHARS,
    OPERATOR_MEMORY_PROMPT_TITLE,
    OPERATOR_USER_PROFILE_MAX_CHARS,
    applyOperatorMemoryMutation,
    checkOperatorMemoryLimits,
    formatOperatorMemoryPromptSection,
    loadOperatorMemoryPromptSection,
    mutateOperatorProfile,
    parseOperatorMemorySnapshot,
} from "./operator-memory"

const dbMocks = vi.hoisted(() => ({
    getDb: vi.fn(),
}))

vi.mock("@/server/db/client", () => dbMocks)

describe("operator memory limits", () => {
    it("单块与合计上限", () => {
        expect(checkOperatorMemoryLimits("a".repeat(OPERATOR_USER_PROFILE_MAX_CHARS), "")).toBe(true)
        expect(checkOperatorMemoryLimits("a".repeat(OPERATOR_USER_PROFILE_MAX_CHARS + 1), "")).toBe(false)
        expect(checkOperatorMemoryLimits("", "b".repeat(OPERATOR_AGENT_NOTES_MAX_CHARS + 1))).toBe(false)
        expect(checkOperatorMemoryLimits(
            "a".repeat(OPERATOR_USER_PROFILE_MAX_CHARS),
            "b".repeat(OPERATOR_AGENT_NOTES_MAX_CHARS),
        )).toBe(true)
        expect(checkOperatorMemoryLimits(
            "a".repeat(OPERATOR_USER_PROFILE_MAX_CHARS),
            `${"b".repeat(OPERATOR_AGENT_NOTES_MAX_CHARS)}x`,
        )).toBe(false)
    })
})

describe("applyOperatorMemoryMutation", () => {
    it("add / replace / remove", () => {
        const added = applyOperatorMemoryMutation("", "", {
            action: "add",
            target: "user_profile",
            text: "偏好简洁",
        })
        expect(added).toEqual({ ok: true, userProfileMd: "偏好简洁", agentNotesMd: "" })

        const replaced = applyOperatorMemoryMutation("偏好简洁", "", {
            action: "replace",
            target: "user_profile",
            old_text: "简洁",
            new_text: "详细",
        })
        expect(replaced).toEqual({ ok: true, userProfileMd: "偏好详细", agentNotesMd: "" })

        const removed = applyOperatorMemoryMutation("偏好详细", "笔记", {
            action: "remove",
            target: "agent_notes",
            old_text: "笔记",
        })
        expect(removed).toEqual({ ok: true, userProfileMd: "偏好详细", agentNotesMd: "" })
    })

    it("old_text 未命中 → invalid_patch", () => {
        expect(applyOperatorMemoryMutation("a", "", {
            action: "replace",
            target: "user_profile",
            old_text: "missing",
            new_text: "x",
        })).toEqual({ ok: false, errorCode: "invalid_patch" })
    })

    it("超限 → memory_limit_exceeded", () => {
        expect(applyOperatorMemoryMutation("a".repeat(OPERATOR_USER_PROFILE_MAX_CHARS), "", {
            action: "add",
            target: "user_profile",
            text: "x",
        })).toEqual({ ok: false, errorCode: "memory_limit_exceeded" })
    })
})

describe("snapshot format", () => {
    it("标题锁定且空内容有占位", () => {
        const section = formatOperatorMemoryPromptSection({
            userProfileMd: "",
            agentNotesMd: "约定 A",
            frozenAt: "2026-07-17T00:00:00.000Z",
        })
        expect(section.startsWith(OPERATOR_MEMORY_PROMPT_TITLE)).toBe(true)
        expect(section).toContain("（空）")
        expect(section).toContain("约定 A")
    })

    it("parse 容错", () => {
        expect(parseOperatorMemorySnapshot(null)).toBeNull()
        expect(parseOperatorMemorySnapshot("{")).toBeNull()
        expect(parseOperatorMemorySnapshot(JSON.stringify({
            userProfileMd: "u",
            agentNotesMd: "n",
            frozenAt: "t",
        }))).toEqual({ userProfileMd: "u", agentNotesMd: "n", frozenAt: "t" })
    })
})

describe("load / mutate persistence", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("非操作员 load 返回 null", async () => {
        expect(await loadOperatorMemoryPromptSection({ id: 2, systemRole: "USER" }, 9)).toBeNull()
        expect(dbMocks.getDb).not.toHaveBeenCalled()
    })

    it("首次 load 从 profile 固化 snapshot", async () => {
        const limit = vi.fn(async () => [{
            id: 9,
            userId: 1,
            snapshotJson: null,
        }])
        const whereSelect = vi.fn(() => ({ limit }))
        const fromSelect = vi.fn(() => ({ where: whereSelect }))
        const profileLimit = vi.fn(async () => [{
            userId: 1,
            userProfileMd: "偏好 A",
            agentNotesMd: "笔记 B",
            updatedAt: new Date(),
        }])
        // second select for profile
        let selectCalls = 0
        const selectRouter = vi.fn(() => {
            selectCalls += 1
            if (selectCalls === 1) return { from: fromSelect }
            const pWhere = vi.fn(() => ({ limit: profileLimit }))
            const pFrom = vi.fn(() => ({ where: pWhere }))
            return { from: pFrom }
        })

        const whereUpdate = vi.fn(async () => undefined)
        const set = vi.fn(() => ({ where: whereUpdate }))
        const update = vi.fn(() => ({ set }))

        dbMocks.getDb.mockReturnValue({ select: selectRouter, update })

        const section = await loadOperatorMemoryPromptSection({ id: 1, systemRole: "SUPER_ADMIN" }, 9)
        expect(section).toContain(OPERATOR_MEMORY_PROMPT_TITLE)
        expect(section).toContain("偏好 A")
        expect(section).toContain("笔记 B")
        expect(update).toHaveBeenCalled()
        const firstCall = (set.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]
        const snapshotArg = firstCall?.[0]?.operatorMemorySnapshotJson
        expect(typeof snapshotArg).toBe("string")
        expect(JSON.parse(snapshotArg as string).userProfileMd).toBe("偏好 A")
    })

    it("已有 snapshot 不再读 profile 覆盖", async () => {
        const snapshot = {
            userProfileMd: "旧画像",
            agentNotesMd: "旧笔记",
            frozenAt: "2026-07-17T00:00:00.000Z",
        }
        const limit = vi.fn(async () => [{
            id: 9,
            userId: 1,
            snapshotJson: JSON.stringify(snapshot),
        }])
        const whereSelect = vi.fn(() => ({ limit }))
        const fromSelect = vi.fn(() => ({ where: whereSelect }))
        const select = vi.fn(() => ({ from: fromSelect }))
        const update = vi.fn()
        dbMocks.getDb.mockReturnValue({ select, update })

        const section = await loadOperatorMemoryPromptSection({ id: 1, systemRole: "SUPER_ADMIN" }, 9)
        expect(section).toContain("旧画像")
        expect(update).not.toHaveBeenCalled()
    })

    it("mutate 非操作员返回 assistant_operator_only", async () => {
        const result = await mutateOperatorProfile({ id: 2, systemRole: "USER" }, {
            action: "add",
            target: "user_profile",
            text: "x",
        })
        expect(result).toEqual({ ok: false, errorCode: "assistant_operator_only" })
    })

    it("mutate upsert profile 且 applied=profile_only", async () => {
        const profileLimit = vi.fn(async () => [{
            userId: 1,
            userProfileMd: "",
            agentNotesMd: "",
            updatedAt: new Date(),
        }])
        const pWhere = vi.fn(() => ({ limit: profileLimit }))
        const pFrom = vi.fn(() => ({ where: pWhere }))
        const select = vi.fn(() => ({ from: pFrom }))
        const onConflictDoUpdate = vi.fn(async () => undefined)
        const values = vi.fn(() => ({ onConflictDoUpdate }))
        const insert = vi.fn(() => ({ values }))
        dbMocks.getDb.mockReturnValue({ select, insert })

        const result = await mutateOperatorProfile({ id: 1, systemRole: "SUPER_ADMIN" }, {
            action: "add",
            target: "user_profile",
            text: "偏好简洁",
        })
        expect(result).toEqual({
            ok: true,
            userProfileChars: "偏好简洁".length,
            agentNotesChars: 0,
            applied: "profile_only",
        })
        expect(insert).toHaveBeenCalled()
    })
})
