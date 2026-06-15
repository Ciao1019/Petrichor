import { describe, expect, it } from "vitest"
import {
    DEFAULT_PROJECT_SHOWCASE,
    buildProjectShowcaseResponse,
    parseItemsJson,
    serializeItems,
    validateProjectShowcaseInput,
    type ProjectItem,
} from "./logic"

describe("project showcase logic", () => {
    it("在数据库无记录时返回默认项目清单", () => {
        const response = buildProjectShowcaseResponse(null)
        expect(response.heading).toBe(DEFAULT_PROJECT_SHOWCASE.heading)
        expect(response.intro).toBe(DEFAULT_PROJECT_SHOWCASE.intro)
        expect(response.items).toHaveLength(DEFAULT_PROJECT_SHOWCASE.items.length)
        expect(response.items[0].name).toBe("Ech0 — self-hosted microblog")
        expect(response.createdAt).toBeNull()
        expect(response.updatedAt).toBeNull()
    })

    it("解析数据库 items JSON 时容错并回退默认值", () => {
        expect(parseItemsJson("{bad", DEFAULT_PROJECT_SHOWCASE.items)).toHaveLength(
            DEFAULT_PROJECT_SHOWCASE.items.length,
        )
        expect(parseItemsJson('{"x":1}', DEFAULT_PROJECT_SHOWCASE.items)).toHaveLength(
            DEFAULT_PROJECT_SHOWCASE.items.length,
        )
        // 合法但为空数组（用户主动清空）应被尊重为空。
        expect(parseItemsJson("[]", DEFAULT_PROJECT_SHOWCASE.items)).toEqual([])
    })

    it("校验后台提交：裁剪文本、拆分技术栈、丢弃无名称项、回退非法颜色", () => {
        const result = validateProjectShowcaseInput({
            heading: "  我的项目  ",
            intro: "  一些东西  ",
            items: [
                {
                    name: "  Ech0  ",
                    year: " 2025 ",
                    stack: ["Go", "Go", " Vue "],
                    stamp: " popular ",
                    stampColor: "rainbow",
                    blurb: " hello \n world ",
                    repoUrl: " https://x.dev ",
                    siteUrl: "",
                },
                { name: "   " },
            ],
        })

        expect(result.heading).toBe("我的项目")
        expect(result.intro).toBe("一些东西")
        expect(result.items).toHaveLength(1)
        const item = result.items[0]
        expect(item.name).toBe("Ech0")
        expect(item.year).toBe("2025")
        expect(item.stack).toEqual(["Go", "Vue"])
        expect(item.stamp).toBe("popular")
        expect(item.stampColor).toBe("red")
        expect(item.blurb).toBe("hello\nworld")
        expect(item.repoUrl).toBe("https://x.dev")
    })

    it("序列化后可被原样解析回来", () => {
        const items: ProjectItem[] = [
            { name: "A", year: "2026", stack: ["TS"], stamp: "new", stampColor: "blue", blurb: "b", repoUrl: "", siteUrl: "" },
        ]
        expect(parseItemsJson(serializeItems(items), DEFAULT_PROJECT_SHOWCASE.items)).toEqual(items)
    })
})
