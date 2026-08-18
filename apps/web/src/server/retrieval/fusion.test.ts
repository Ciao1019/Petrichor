import { describe, expect, it } from "vitest"
import { reciprocalRankFusion, toRecallHits } from "./fusion"

describe("RRF 融合", () => {
    it("被多路命中的候选排名更高", () => {
        const fused = reciprocalRankFusion([
            toRecallHits("tree", [{ nodeKey: "a" }, { nodeKey: "b" }]),
            toRecallHits("vector", [{ nodeKey: "b" }, { nodeKey: "c" }]),
            toRecallHits("bm25", [{ nodeKey: "b" }, { nodeKey: "d" }]),
        ])
        expect(fused[0].nodeKey).toBe("b")
        expect(fused[0].recallSources.sort()).toEqual(["bm25", "tree", "vector"])
    })

    it("单路命中的候选也会保留", () => {
        const fused = reciprocalRankFusion([toRecallHits("bm25", [{ nodeKey: "only" }])])
        expect(fused.map((item) => item.nodeKey)).toEqual(["only"])
    })

    it("某一路为空不影响融合（召回降级容错）", () => {
        const fused = reciprocalRankFusion([
            toRecallHits("tree", [{ nodeKey: "a" }]),
            toRecallHits("vector", []),
        ])
        expect(fused).toHaveLength(1)
    })

    it("权重可以放大某一路的贡献", () => {
        const balanced = reciprocalRankFusion([
            toRecallHits("tree", [{ nodeKey: "t" }]),
            toRecallHits("bm25", [{ nodeKey: "b" }]),
        ])
        const bm25Heavy = reciprocalRankFusion([
            toRecallHits("tree", [{ nodeKey: "t" }]),
            toRecallHits("bm25", [{ nodeKey: "b" }]),
        ], { weights: { bm25: 5 } })
        expect(balanced[0].nodeKey).toBe("t")
        expect(bm25Heavy[0].nodeKey).toBe("b")
    })

    it("同源多次命中保留最靠前排名", () => {
        const fused = reciprocalRankFusion([
            toRecallHits("bm25", [{ nodeKey: "x" }, { nodeKey: "y" }]),
            toRecallHits("bm25", [{ nodeKey: "y" }, { nodeKey: "x" }]),
        ])
        expect(fused.find((item) => item.nodeKey === "x")?.ranks.bm25).toBe(1)
    })

    it("topK 截断融合结果", () => {
        const fused = reciprocalRankFusion([
            toRecallHits("tree", [{ nodeKey: "a" }, { nodeKey: "b" }, { nodeKey: "c" }]),
        ], { topK: 2 })
        expect(fused).toHaveLength(2)
    })

    it("k 越大越弱化头部优势", () => {
        const small = reciprocalRankFusion([toRecallHits("tree", [{ nodeKey: "a" }, { nodeKey: "b" }])], { k: 1 })
        const large = reciprocalRankFusion([toRecallHits("tree", [{ nodeKey: "a" }, { nodeKey: "b" }])], { k: 1000 })
        const smallGap = small[0].fusedScore - small[1].fusedScore
        const largeGap = large[0].fusedScore - large[1].fusedScore
        expect(smallGap).toBeGreaterThan(largeGap)
    })
})
