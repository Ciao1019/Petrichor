import { describe, expect, it } from "vitest"

import { extractAgentImageReferences } from "./wiki-agent-logic"

describe("wiki agent media extraction", () => {
    it("从 Markdown 图片和裸 uploads 路径中提取可渲染图片引用", () => {
        const refs = extractAgentImageReferences([
            "![架构图](s4key:uploads/2/arch.webp)",
            "补充路径 uploads/2/extra.png",
            "重复路径 uploads/2/arch.webp",
        ].join("\n"))

        expect(refs).toEqual([
            {
                id: "image-1",
                alt: "架构图",
                src: "s4key:uploads/2/arch.webp",
                objectKey: "uploads/2/arch.webp",
                filename: "arch.webp",
            },
            {
                id: "image-2",
                alt: "extra.png",
                src: "s4key:uploads/2/extra.png",
                objectKey: "uploads/2/extra.png",
                filename: "extra.png",
            },
        ])
    })

    it("忽略非图片对象和非图片外链", () => {
        const refs = extractAgentImageReferences("uploads/2/readme.txt\nhttps://example.com/page")

        expect(refs).toEqual([])
    })
})
