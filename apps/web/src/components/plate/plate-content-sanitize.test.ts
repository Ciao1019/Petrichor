import { KEYS, type Value } from "platejs"
import { describe, expect, it } from "vitest"

import { sanitizeEditorContentForPersistence } from "./plate-content-sanitize"

describe("sanitizeEditorContentForPersistence", () => {
    it("移除根级上传占位节点并保留真实图片节点", () => {
        const value = [
            {
                type: KEYS.p,
                children: [{ text: "前置文本" }],
            },
            {
                id: "placeholder-1",
                mediaType: KEYS.img,
                type: KEYS.placeholder,
                children: [{ text: "" }],
            },
            {
                type: KEYS.img,
                url: "s4key:uploads/1/a.png",
                children: [{ text: "" }],
            },
        ] as Value

        expect(sanitizeEditorContentForPersistence(value)).toEqual([
            {
                type: KEYS.p,
                children: [{ text: "前置文本" }],
            },
            {
                type: KEYS.img,
                url: "s4key:uploads/1/a.png",
                children: [{ text: "" }],
            },
        ])
    })

    it("移除嵌套占位节点后保留父节点结构", () => {
        const value = [
            {
                type: KEYS.p,
                children: [
                    { text: "A" },
                    {
                        mediaType: KEYS.img,
                        type: KEYS.placeholder,
                        children: [{ text: "" }],
                    },
                    { text: "B" },
                ],
            },
        ] as Value

        expect(sanitizeEditorContentForPersistence(value)).toEqual([
            {
                type: KEYS.p,
                children: [{ text: "A" }, { text: "B" }],
            },
        ])
    })

    it("内容只剩占位节点时返回合法空段落", () => {
        const value = [
            {
                mediaType: KEYS.img,
                type: KEYS.placeholder,
                children: [{ text: "" }],
            },
        ] as Value

        expect(sanitizeEditorContentForPersistence(value)).toEqual([
            {
                type: KEYS.p,
                children: [{ text: "" }],
            },
        ])
    })
})
