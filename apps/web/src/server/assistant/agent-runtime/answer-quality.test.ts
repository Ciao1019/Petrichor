import { describe, expect, it } from "vitest"
import {
    assessAnswerQuality,
    buildAnswerQualityGuidance,
    dedupeRepeatedAnswer,
    resolveAnswerDepth,
} from "./answer-quality"
import type { AgentEvidence } from "./types"

function evidence(content: string): AgentEvidence {
    return {
        id: "e1",
        source: "knowledge",
        title: "小鼹鼠",
        content,
        createdAt: 1,
    }
}

describe("回答详略度", () => {
    it("普通‘是什么’问题默认要求完整介绍，而不是一句话", () => {
        expect(resolveAnswerDepth("小鼹鼠是什么")).toBe("standard")
        const guidance = buildAnswerQualityGuidance("小鼹鼠是什么")
        expect(guidance).toContain("它是什么、核心能力、怎么使用或适合谁、限制/注意事项")
        expect(guidance).toContain("不要只把多条证据压成一句定义")
    })

    it("明确要求一句话时尊重用户的简短偏好", () => {
        expect(resolveAnswerDepth("一句话告诉我小鼹鼠是什么")).toBe("brief")
        const result = assessAnswerQuality({
            goal: "一句话告诉我小鼹鼠是什么",
            answer: "小鼹鼠是一款 macOS 清理工具 [1]。",
            evidence: [evidence("功能介绍".repeat(200))],
        })
        expect(result.adequate).toBe(true)
    })

    it("证据丰富却只答一句时判定为草率", () => {
        const result = assessAnswerQuality({
            goal: "小鼹鼠是什么",
            answer: "小鼹鼠是一款开源、免费的 macOS 命令行清理工具，支持清理垃圾文件、缓存和残留文件 [1]。",
            evidence: [evidence("定位、核心能力、使用方式、支持模块、限制与注意事项。".repeat(80))],
        })
        expect(result.adequate).toBe(false)
        expect(result.reasons).toHaveLength(2)
    })

    it("覆盖多个信息点的完整回答可以通过", () => {
        const answer = [
            "小鼹鼠是一款面向 macOS 的开源命令行维护工具，主要用于集中处理清理、卸载和系统检查 [1]。",
            "它的核心能力包括扫描缓存与残留文件、卸载应用关联内容、分析磁盘占用，并提供部分系统优化和监控入口 [1]。",
            "它更适合习惯终端、希望把多种维护操作放进统一工作流的用户；普通用户使用前应先查看待删除项目，避免误清理仍有用的数据 [1]。",
            "需要注意的是，它不是 macOS 自带组件，执行清理命令前仍应确认权限、备份重要数据，并以项目文档支持的系统版本为准 [1]。",
        ].join("\n\n")
        const result = assessAnswerQuality({
            goal: "小鼹鼠是什么",
            answer,
            evidence: [evidence("定位、核心能力、使用方式、支持模块、限制与注意事项。".repeat(20))],
        })
        expect(result.adequate).toBe(true)
    })

    it("证据本身很少时不强迫模型灌水", () => {
        const result = assessAnswerQuality({
            goal: "小鼹鼠是什么",
            answer: "现有资料只说明它是一款 macOS 清理工具 [1]。",
            evidence: [evidence("小鼹鼠是一款 macOS 清理工具。")],
        })
        expect(result.adequate).toBe(true)
    })

    it("移除流式重启造成的完全重复句，不影响不同要点", () => {
        const answer = [
            "Mole 是一款 macOS 清理工具 [1]。Mole 是一款 macOS 清理工具 [1]。",
            "",
            "它还支持扫描应用卸载残留 [2]。",
            "它还支持扫描应用卸载残留 [2]。",
        ].join("\n")

        expect(dedupeRepeatedAnswer(answer)).toBe(
            "Mole 是一款 macOS 清理工具 [1]。\n\n它还支持扫描应用卸载残留 [2]。",
        )
    })
})
