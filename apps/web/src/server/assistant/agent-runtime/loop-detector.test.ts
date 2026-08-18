import { describe, expect, it } from "vitest"
import { LoopDetector, querySimilarity, stableHash } from "./loop-detector"

describe("LoopDetector", () => {
    it("同工具同参数连续 3 次判定为死循环", () => {
        const detector = new LoopDetector()
        const call = { toolId: "knowledge.search", input: { query: "redis" }, producedEvidence: false }

        expect(detector.record(call)).toBeNull()
        expect(detector.record(call)).toBeNull()
        expect(detector.record(call)).toMatchObject({ kind: "exact_repeat", times: 3 })
    })

    it("参数不同则不算完全重复", () => {
        const detector = new LoopDetector()
        expect(detector.record({ toolId: "knowledge.search", input: { query: "a" }, producedEvidence: true })).toBeNull()
        expect(detector.record({ toolId: "knowledge.search", input: { query: "b" }, producedEvidence: true })).toBeNull()
        expect(detector.record({ toolId: "knowledge.search", input: { query: "c" }, producedEvidence: true })).toBeNull()
    })

    it("A→B→A→B→A→B 判定为调用环", () => {
        const detector = new LoopDetector({ noProgressThreshold: 99 })
        let signal = null
        for (let i = 0; i < 3; i += 1) {
            signal = detector.record({ toolId: "knowledge.search", input: { query: `q${i}` }, producedEvidence: true })
            signal = detector.record({ toolId: "knowledge.read", input: { nodeKey: `n${i}` }, producedEvidence: true })
        }
        // 参数每轮不同，所以 pattern 只在参数相同时成立；这里验证参数相同的交替
        const alt = new LoopDetector({ noProgressThreshold: 99 })
        for (let i = 0; i < 3; i += 1) {
            alt.record({ toolId: "knowledge.search", input: { query: "x" }, producedEvidence: true })
            signal = alt.record({ toolId: "knowledge.read", input: { nodeKey: "n" }, producedEvidence: true })
        }
        expect(signal).toMatchObject({ kind: "pattern_loop" })
    })

    it("连续多次无新证据判定为无进展", () => {
        const detector = new LoopDetector({ noProgressThreshold: 3 })
        detector.record({ toolId: "a.x", input: { query: "1" }, producedEvidence: false })
        detector.record({ toolId: "b.y", input: { query: "2" }, producedEvidence: false })
        const signal = detector.record({ toolId: "c.z", input: { query: "3" }, producedEvidence: false })
        expect(signal).toMatchObject({ kind: "no_evidence_progress", calls: 3 })
        expect(detector.noProgressStreak()).toBe(3)
    })

    it("相似 query 且结果指纹相同判定为重复检索", () => {
        const detector = new LoopDetector({ noProgressThreshold: 99 })
        const output = { hits: [{ nodeKey: "a1-0" }] }
        detector.record({ toolId: "knowledge.search", input: { query: "Redis 部署方式" }, output, producedEvidence: true })
        const signal = detector.record({
            toolId: "knowledge.search",
            input: { query: "Redis 部署方式？" },
            output,
            producedEvidence: true,
        })
        expect(signal).toMatchObject({ kind: "duplicate_search" })
    })

    it("产生证据后重置无进展计数", () => {
        const detector = new LoopDetector({ noProgressThreshold: 3 })
        detector.record({ toolId: "a.x", input: { q: 1 }, producedEvidence: false })
        detector.record({ toolId: "a.x", input: { q: 2 }, producedEvidence: true })
        expect(detector.noProgressStreak()).toBe(0)
    })
})

describe("stableHash", () => {
    it("key 顺序不同得到同一指纹", () => {
        expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }))
    })

    it("值不同得到不同指纹", () => {
        expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }))
    })
})

describe("querySimilarity", () => {
    it("中文近似查询得到高相似度", () => {
        expect(querySimilarity("Redis 怎么部署", "Redis怎么部署？")).toBeGreaterThan(0.9)
    })

    it("无关查询相似度低", () => {
        expect(querySimilarity("Redis 部署", "认证模块安全风险")).toBeLessThan(0.3)
    })
})
