import { describe, expect, it, vi } from "vitest"
import {
    bboxToPixelRect,
    embedExtractedImages,
    parseBbox,
    parseEmbeddedImagePlaceholders,
    type EmbedImageDeps,
} from "./import-image-extract"

describe("import 嵌入图占位符解析", () => {
    it("解析合法 bbox 并裁剪到 [0,1]", () => {
        expect(parseBbox("0.1,0.2,0.8,0.6")).toEqual({ x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.6 })
        expect(parseBbox(" 0.1 , 0.2 , 0.8 , 0.6 ")).toEqual({ x0: 0.1, y0: 0.2, x1: 0.8, y1: 0.6 })
        expect(parseBbox("-0.2,0,1.5,1")).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 })
    })

    it("拒绝非法 / 退化的 bbox", () => {
        expect(parseBbox(undefined)).toBeNull()
        expect(parseBbox("0.1,0.2,0.8")).toBeNull()
        expect(parseBbox("a,b,c,d")).toBeNull()
        expect(parseBbox("0.8,0.2,0.1,0.6")).toBeNull() // x1<=x0
        expect(parseBbox("0.1,0.6,0.8,0.6")).toBeNull() // y1<=y0
    })

    it("扫描出全部占位符（含无坐标的退化形式）", () => {
        const md = "前言\n\n![柱状图](image#bbox=0.1,0.2,0.8,0.6)\n\n中段 ![无坐标](image) 结尾"
        const found = parseEmbeddedImagePlaceholders(md)
        expect(found).toHaveLength(2)
        expect(found[0].alt).toBe("柱状图")
        expect(found[0].bbox).not.toBeNull()
        expect(found[1].alt).toBe("无坐标")
        expect(found[1].bbox).toBeNull()
    })

    it("归一化 bbox 转像素框并按比例外扩、边界裁剪", () => {
        const rect = bboxToPixelRect({ x0: 0, y0: 0, x1: 0.5, y1: 0.5 }, { width: 1000, height: 1000 })
        // 外扩 1% = 10px，左上贴边被裁到 0，右下扩到 510
        expect(rect).toEqual({ left: 0, top: 0, width: 510, height: 510 })
    })

    it("过小的裁剪框返回 null", () => {
        expect(bboxToPixelRect({ x0: 0.5, y0: 0.5, x1: 0.501, y1: 0.501 }, { width: 100, height: 100 })).toBeNull()
    })
})

describe("embedExtractedImages 替换流程", () => {
    const pageImage = { data: Buffer.from("fake"), mime: "image/jpeg" }

    function makeDeps(overrides: Partial<EmbedImageDeps> = {}): EmbedImageDeps {
        return {
            measure: vi.fn(async () => ({ width: 1000, height: 1000 })),
            crop: vi.fn(async () => Buffer.from("jpeg")),
            upload: vi.fn(async () => "uploads/7/abc.jpg"),
            ...overrides,
        }
    }

    it("无占位符时原样返回，不触碰图片", async () => {
        const deps = makeDeps()
        const md = "# 标题\n\n纯文本内容"
        expect(await embedExtractedImages({ userId: 7, markdown: md, pageImage, deps })).toBe(md)
        expect(deps.measure).not.toHaveBeenCalled()
    })

    it("带坐标的占位符替换为 s4key 图片", async () => {
        const deps = makeDeps()
        const md = "见下图：\n\n![柱状图](image#bbox=0.1,0.2,0.8,0.6)\n\n结束"
        const out = await embedExtractedImages({ userId: 7, markdown: md, pageImage, deps })
        expect(out).toBe("见下图：\n\n![柱状图](s4key:uploads/7/abc.jpg)\n\n结束")
        expect(deps.crop).toHaveBeenCalledTimes(1)
        expect(deps.upload).toHaveBeenCalledWith(7, expect.any(Buffer))
    })

    it("无坐标的占位符降级为纯文本", async () => {
        const deps = makeDeps()
        const out = await embedExtractedImages({ userId: 7, markdown: "![插图](image)", pageImage, deps })
        expect(out).toBe("*（图：插图）*")
        expect(deps.crop).not.toHaveBeenCalled()
    })

    it("单个占位符裁剪失败时仅该处降级，其余正常", async () => {
        const crop = vi
            .fn()
            .mockResolvedValueOnce(Buffer.from("ok"))
            .mockRejectedValueOnce(new Error("crop failed"))
        const deps = makeDeps({ crop })
        const md = "![图一](image#bbox=0,0,0.4,0.4)\n\n![图二](image#bbox=0.5,0.5,0.9,0.9)"
        const out = await embedExtractedImages({ userId: 7, markdown: md, pageImage, deps })
        expect(out).toBe("![图一](s4key:uploads/7/abc.jpg)\n\n*（图：图二）*")
    })

    it("整页尺寸读取失败时全部降级为文本，不留坏链接", async () => {
        const deps = makeDeps({ measure: vi.fn(async () => Promise.reject(new Error("no sharp"))) })
        const md = "![图一](image#bbox=0,0,0.4,0.4) 与 ![图二](image)"
        const out = await embedExtractedImages({ userId: 7, markdown: md, pageImage, deps })
        expect(out).toBe("*（图：图一）* 与 *（图：图二）*")
        expect(deps.crop).not.toHaveBeenCalled()
    })
})
