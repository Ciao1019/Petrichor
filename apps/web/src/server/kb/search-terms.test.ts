import { describe, expect, it } from "vitest"
import { makeNgrams, scoreSearchFields, tokenizeSearchQuery } from "./search-terms"

describe("search-terms", () => {
    it("中文整句会展开 2/3 字 n-gram", () => {
        const terms = tokenizeSearchQuery("全部歌曲下载进度")
        expect(terms).toContain("全部歌曲下载进度")
        expect(terms).toContain("歌曲")
        expect(terms).toContain("下载")
        expect(terms).toContain("进度")
        expect(terms).toContain("歌曲下")
    })

    it("空格分词保留整词且中文段仍展开 n-gram", () => {
        const terms = tokenizeSearchQuery("歌曲 下载 进度")
        expect(terms).toEqual(expect.arrayContaining(["歌曲", "下载", "进度"]))
    })

    it("「全部歌曲下载进度」能命中标题「歌曲下载进度」", () => {
        const score = scoreSearchFields(
            { title: "歌曲下载进度", summary: "歌曲列表", content: "" },
            "全部歌曲下载进度",
        )
        expect(score).toBeGreaterThan(0)
    })

    it("精确标题命中分高于近邻命中", () => {
        const exact = scoreSearchFields({ title: "歌曲下载进度" }, "歌曲下载进度")
        const fuzzy = scoreSearchFields({ title: "歌曲下载进度" }, "全部歌曲下载进度")
        expect(exact).toBeGreaterThan(fuzzy)
        expect(fuzzy).toBeGreaterThan(0)
    })

    it("无关标题不得分", () => {
        expect(scoreSearchFields({ title: "编程规范" }, "全部歌曲下载进度")).toBe(0)
        expect(scoreSearchFields({ title: "MAC 使用" }, "全部歌曲下载进度")).toBe(0)
    })

    it("makeNgrams 边界", () => {
        expect(makeNgrams("ab", 2)).toEqual(["ab"])
        expect(makeNgrams("a", 2)).toEqual([])
        expect(makeNgrams("abcd", 3)).toEqual(["abc", "bcd"])
    })
})
