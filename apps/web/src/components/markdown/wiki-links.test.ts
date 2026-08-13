import { describe, expect, it } from "vitest"

import { parseWikiLinkTarget, preprocessWikiLinks, slugDisplayName, wikiSlugFromHref } from "./wiki-links"

describe("parseWikiLinkTarget", () => {
    it("拆出 slug 与显示名", () => {
        expect(parseWikiLinkTarget("entity/zsh|Zsh")).toEqual({ slug: "entity/zsh", display: "Zsh" })
    })

    it("没有显示名时回退到 slug 末段", () => {
        expect(parseWikiLinkTarget("entity/spring-festival")).toEqual({ slug: "entity/spring-festival", display: "spring festival" })
    })
})

describe("slugDisplayName", () => {
    it("取末段并把连字符换成空格", () => {
        expect(slugDisplayName("concept/void-resonance")).toBe("void resonance")
        expect(slugDisplayName("索引")).toBe("索引")
    })
})

describe("preprocessWikiLinks", () => {
    it("把 [[slug]] 改写成锚点链接", () => {
        expect(preprocessWikiLinks("见 [[entity/zsh|Zsh]] 的说明"))
            .toBe("见 [Zsh](#wiki:entity%2Fzsh) 的说明")
    })

    it("用 resolveDisplay 替换成页面真实标题", () => {
        expect(preprocessWikiLinks("[[entity/zsh]]", (slug) => (slug === "entity/zsh" ? "Zsh 使用说明" : undefined)))
            .toBe("[Zsh 使用说明](#wiki:entity%2Fzsh)")
    })

    it("resolveDisplay 返回 undefined 时保留原显示名", () => {
        expect(preprocessWikiLinks("[[entity/zsh|Zsh]]", () => undefined)).toBe("[Zsh](#wiki:entity%2Fzsh)")
    })

    it("不改写代码块与行内代码里的字面量", () => {
        const fenced = "```md\n[[entity/zsh]]\n```"
        expect(preprocessWikiLinks(fenced)).toBe(fenced)
        expect(preprocessWikiLinks("行内 `[[entity/zsh]]` 保留")).toBe("行内 `[[entity/zsh]]` 保留")
    })

    it("转义显示名里的左方括号，避免截断链接语法", () => {
        expect(preprocessWikiLinks("[[a|前[中]]")).toBe("[前\\[中](#wiki:a)")
    })

    it("显示名里出现右方括号时整段保持原样，不产生半截链接", () => {
        expect(preprocessWikiLinks("[[a|前]后]]")).toBe("[[a|前]后]]")
    })

    it("正文没有双链时原样返回", () => {
        expect(preprocessWikiLinks("普通正文")).toBe("普通正文")
    })

    it("一行内的多个双链都会改写", () => {
        expect(preprocessWikiLinks("[[a|A]] 与 [[b|B]]")).toBe("[A](#wiki:a) 与 [B](#wiki:b)")
    })
})

describe("wikiSlugFromHref", () => {
    it("还原被编码的 slug", () => {
        expect(wikiSlugFromHref("#wiki:entity%2Fzsh")).toBe("entity/zsh")
    })

    it("普通链接返回 null", () => {
        expect(wikiSlugFromHref("https://example.com")).toBeNull()
        expect(wikiSlugFromHref("#section")).toBeNull()
        expect(wikiSlugFromHref(undefined)).toBeNull()
    })
})
