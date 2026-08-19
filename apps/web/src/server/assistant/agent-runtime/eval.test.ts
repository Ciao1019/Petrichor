import { describe, expect, it } from "vitest"
import { calculateAnswerRepetitionRate } from "./eval"

describe("answer repetition metric", () => {
    it("忽略引用编号后识别重复回答", () => {
        expect(calculateAnswerRepetitionRate(
            "Mole 是一款 macOS 清理工具 [1]。Mole 是一款 macOS 清理工具 [2]。它支持卸载残留清理。",
        )).toBeCloseTo(1 / 3, 3)
    })

    it("不同要点不误判为重复", () => {
        expect(calculateAnswerRepetitionRate(
            "Mole 是一款 macOS 清理工具。它支持缓存清理。它也可以扫描卸载残留。",
        )).toBe(0)
    })
})
