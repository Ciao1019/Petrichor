import { MarkdownPlugin, remarkMdx } from "@platejs/markdown"
import { createPlateEditor, createPlatePlugin } from "platejs/react"
import { describe, expect, it } from "vitest"

import { MarkdownKit } from "@/components/editor/plugins/markdown-kit"

import {
    EMBED_CARD_TYPE,
    embedCardMarkdownRules,
    getSpotifyEmbedUrl,
    getTweetId,
    postprocessEmbedDirectives,
    preprocessEmbedDirectives,
    serializeEmbedCardDirective,
    type EmbedCardElement,
} from "./plate-embed-directives"

function createEditor(value?: EmbedCardElement[]) {
    const embedCardPlugin = createPlatePlugin({
        key: EMBED_CARD_TYPE,
        node: {
            isElement: true,
            isVoid: true,
        },
    })

    return createPlateEditor({
        plugins: [
            embedCardPlugin,
            MarkdownPlugin.configure({
                options: {
                    remarkPlugins: [remarkMdx],
                    rules: embedCardMarkdownRules,
                },
            }),
        ],
        value,
    })
}

describe("Plate embed directives", () => {
    it("将双冒号语法预处理为 Plate Markdown 可识别的 MDX 节点", () => {
        expect(
            preprocessEmbedDirectives('::github{repo="radishzzz/astro-theme-retypeset"}')
        ).toBe('<embed_card provider="github" repo="radishzzz/astro-theme-retypeset" />')

        expect(
            preprocessEmbedDirectives(
                '::spotify{url="https://open.spotify.com/track/0HYAsQwJIO6FLqpyTeD3l6"}'
            )
        ).toBe(
            '<embed_card provider="spotify" url="https://open.spotify.com/track/0HYAsQwJIO6FLqpyTeD3l6" />'
        )
    })

    it("忽略缺少必要参数的 directive，保留原始文本", () => {
        expect(preprocessEmbedDirectives("::github{}")).toBe("::github{}")
        expect(preprocessEmbedDirectives('::spotify{url="https://example.com"}')).toBe(
            '::spotify{url="https://example.com"}'
        )
        expect(
            preprocessEmbedDirectives('    ::github{repo="radishzzz/astro-theme-retypeset"}')
        ).toBe('    ::github{repo="radishzzz/astro-theme-retypeset"}')
    })

    it("从常见 URL 中提取嵌入信息", () => {
        expect(getTweetId("https://x.com/JustinLin610/status/2037116325210829168")).toBe(
            "2037116325210829168"
        )
        expect(getSpotifyEmbedUrl("spotify:track:0HYAsQwJIO6FLqpyTeD3l6")).toBe(
            "https://open.spotify.com/embed/track/0HYAsQwJIO6FLqpyTeD3l6"
        )
        expect(
            getSpotifyEmbedUrl(
                "https://open.spotify.com/album/03QiFOKDh6xMiSTkOnsmMG?si=test"
            )
        ).toBe("https://open.spotify.com/embed/album/03QiFOKDh6xMiSTkOnsmMG")
    })

    it("在 Markdown 反序列化时创建 embed_card 节点", () => {
        const editor = createEditor()

        expect(
            editor.getApi(MarkdownPlugin).markdown.deserialize(
                preprocessEmbedDirectives(
                    [
                        "# 卡片",
                        "",
                        '::github{repo="radishzzz/astro-theme-retypeset"}',
                        "",
                        '::tweet{url="https://x.com/JustinLin610/status/2037116325210829168"}',
                    ].join("\n")
                )
            )
        ).toMatchObject([
            { type: "h1" },
            {
                type: EMBED_CARD_TYPE,
                provider: "github",
                repo: "radishzzz/astro-theme-retypeset",
            },
            {
                type: EMBED_CARD_TYPE,
                provider: "tweet",
                url: "https://x.com/JustinLin610/status/2037116325210829168",
            },
        ])
    })

    it("在 Markdown 序列化时恢复为双冒号语法", () => {
        const editor = createEditor([
            {
                type: EMBED_CARD_TYPE,
                provider: "github",
                repo: "radishzzz/astro-theme-retypeset",
                children: [{ text: "" }],
            },
            {
                type: EMBED_CARD_TYPE,
                provider: "spotify",
                url: "https://open.spotify.com/track/0HYAsQwJIO6FLqpyTeD3l6",
                children: [{ text: "" }],
            },
        ])

        const markdown = postprocessEmbedDirectives(
            editor.getApi(MarkdownPlugin).markdown.serialize()
        )

        expect(markdown).toContain(
            '::github{repo="radishzzz/astro-theme-retypeset"}'
        )
        expect(markdown).toContain(
            '::spotify{url="https://open.spotify.com/track/0HYAsQwJIO6FLqpyTeD3l6"}'
        )
    })

    it("粘贴纯文本 directive 时先交给 Markdown parser 预处理", () => {
        const editor = createPlateEditor({
            plugins: [...MarkdownKit],
        })
        const parser = editor.getPlugin(MarkdownPlugin).parser

        expect(parser?.transformData?.({
            data: '::tweet{url="https://x.com/JustinLin610/status/2037116325210829168"}',
            dataTransfer: { files: [], getData: () => "" } as unknown as DataTransfer,
            editor,
            mimeType: "text/plain",
        } as never)).toBe(
            '<embed_card provider="tweet" url="https://x.com/JustinLin610/status/2037116325210829168" />'
        )
    })

    it("将序列化产生的 embed_card MDX 标签后处理为 directive", () => {
        expect(
            postprocessEmbedDirectives(
                '<embed_card provider="github" repo="radishzzz/astro-theme-retypeset" />'
            )
        ).toBe('::github{repo="radishzzz/astro-theme-retypeset"}')
        expect(
            serializeEmbedCardDirective({
                provider: "tweet",
                url: "https://twitter.com/user/status/123",
            })
        ).toBe('::tweet{url="https://twitter.com/user/status/123"}')
    })
})
