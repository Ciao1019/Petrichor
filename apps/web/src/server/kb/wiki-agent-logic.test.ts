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
                kind: "image",
                alt: "架构图",
                src: "s4key:uploads/2/arch.webp",
                objectKey: "uploads/2/arch.webp",
                filename: "arch.webp",
            },
            {
                id: "image-2",
                kind: "image",
                alt: "extra.png",
                src: "s4key:uploads/2/extra.png",
                objectKey: "uploads/2/extra.png",
                filename: "extra.png",
            },
        ])
    })

    it("提取视频/文件等附件，按类型分别编号", () => {
        const refs = extractAgentImageReferences([
            "<video src=\"s4key:uploads/2/demo.mp4\"></video>",
            "[使用手册](s4key:uploads/2/manual.pdf)",
            "裸路径附件 uploads/2/readme.txt",
        ].join("\n"))

        // id 按扫描顺序（Markdown 链接 → HTML 媒体 → 裸路径）在同类型内自增，与文档顺序无关。
        expect(refs).toEqual([
            {
                id: "file-1",
                kind: "file",
                alt: "使用手册",
                src: "s4key:uploads/2/manual.pdf",
                objectKey: "uploads/2/manual.pdf",
                filename: "manual.pdf",
            },
            {
                id: "video-1",
                kind: "video",
                alt: "demo.mp4",
                src: "s4key:uploads/2/demo.mp4",
                objectKey: "uploads/2/demo.mp4",
                filename: "demo.mp4",
            },
            {
                id: "file-2",
                kind: "file",
                alt: "readme.txt",
                src: "s4key:uploads/2/readme.txt",
                objectKey: "uploads/2/readme.txt",
                filename: "readme.txt",
            },
        ])
    })

    it("从编辑器 <file> 上传标签提取附件，用 name 属性作真实文件名（含 .icls 等任意扩展名）", () => {
        const refs = extractAgentImageReferences(
            '<file isUpload="true" name="Arc_Dark__Material__go.icls" placeholderId="x" src="s4key:uploads/2/c0f4c968-cd95-4afe-9425-2e5b54e7297d.icls" />',
        )

        expect(refs).toEqual([
            {
                id: "file-1",
                kind: "file",
                alt: "Arc_Dark__Material__go.icls",
                src: "s4key:uploads/2/c0f4c968-cd95-4afe-9425-2e5b54e7297d.icls",
                objectKey: "uploads/2/c0f4c968-cd95-4afe-9425-2e5b54e7297d.icls",
                filename: "Arc_Dark__Material__go.icls",
            },
        ])
    })

    it("忽略无法识别媒体类型的外链", () => {
        const refs = extractAgentImageReferences("https://example.com/page\n[首页](https://example.com/home)")

        expect(refs).toEqual([])
    })
})
