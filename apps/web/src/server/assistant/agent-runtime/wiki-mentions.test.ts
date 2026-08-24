import { describe, expect, it } from "vitest"

import {
    annotateNormalQaWikiMentions,
    collectWikiMentionTargets,
    mergeWikiMentionTargets,
    type WikiMentionTarget,
} from "./wiki-mentions"
import { createObservation } from "./observation"
import type { AgentEvidence } from "./types"

function target(
    pageKey: string,
    title: string,
    options: Partial<WikiMentionTarget> = {},
): WikiMentionTarget {
    return {
        pageKey,
        title,
        aliases: options.aliases ?? [],
        kind: options.kind ?? "entity",
        citationIndex: options.citationIndex ?? null,
    }
}

describe("annotateNormalQaWikiMentions", () => {
    it("给普通问答里的实体和概念首次提及补 Wiki 标注，同时保留来源角标", () => {
        expect(annotateNormalQaWikiMentions(
            "小鼹鼠（Mole）支持深度清理，深度清理完成后输出结果 [1]。",
            [
                target("entity-mole", "小鼹鼠", { aliases: ["Mole"] }),
                target("concept-deep-clean", "深度清理", { kind: "concept" }),
            ],
        )).toBe(
            "[[entity-mole|小鼹鼠]]（Mole）支持[[concept-deep-clean|深度清理]]，深度清理完成后输出结果 [1]。",
        )
    })

    it("把旧式句末 Wiki 伪角标恢复成数字来源，并把波浪线移到正文实体上", () => {
        expect(annotateNormalQaWikiMentions(
            "小鼹鼠（Mole）是一款 macOS 清理工具 [[entity-mole|小鼹鼠]]。",
            [target("entity-mole", "小鼹鼠", { aliases: ["Mole"], citationIndex: 1 })],
        )).toBe("[[entity-mole|小鼹鼠]]（Mole）是一款 macOS 清理工具 [1]。")
    })

    it("不改代码、已有链接和 fenced code，也不重复标同一页面", () => {
        const markdown = [
            "`Mole` [Mole](https://example.com) 正文 Mole，再次 Mole。",
            "```sh",
            "Mole --help",
            "```",
        ].join("\n")
        expect(annotateNormalQaWikiMentions(markdown, [target("entity-mole", "Mole")])).toBe([
            "`Mole` [Mole](https://example.com) 正文 [[entity-mole|Mole]]，再次 Mole。",
            "```sh",
            "Mole --help",
            "```",
        ].join("\n"))
    })

    it("不标 source 页面，也不把英文短词嵌进更长标识符", () => {
        expect(annotateNormalQaWikiMentions(
            "macOS 的来源文章介绍了 Mac。",
            [
                target("entity-mac", "Mac"),
                target("source-8", "来源文章", { kind: "source" }),
            ],
        )).toBe("macOS 的来源文章介绍了 [[entity-mac|Mac]]。")
    })
})

describe("collectWikiMentionTargets", () => {
    it("从证据、关联页面和检索命中汇总真实实体/概念，并带上稳定来源编号", () => {
        const evidence: AgentEvidence = {
            id: "ev-1",
            source: "knowledge",
            title: "小鼹鼠",
            content: "关联深度清理。",
            metadata: {
                pageKey: "entity-mole",
                pageKind: "entity",
                aliases: ["Mole"],
                wikiTargets: [
                    { pageKey: "entity-cleanmymac", title: "CleanMyMac", pageKind: "entity" },
                    { pageKey: "concept-deep-clean", title: "深度清理", pageKind: "concept" },
                ],
            },
            createdAt: 1,
        }
        const observation = createObservation({
            type: "knowledge_search",
            source: "knowledge.search",
            summary: "命中",
            data: {
                hits: [
                    { pageKey: "concept-cache", title: "缓存清理", pageKind: "concept" },
                    { pageKey: "source-8", title: "来源文章", pageKind: "source" },
                ],
            },
        })

        expect(collectWikiMentionTargets([evidence], [observation], () => 2)).toEqual([
            target("entity-mole", "小鼹鼠", { aliases: ["Mole"], citationIndex: 2 }),
            target("entity-cleanmymac", "CleanMyMac"),
            target("concept-deep-clean", "深度清理", { kind: "concept" }),
            target("concept-cache", "缓存清理", { kind: "concept" }),
        ])
    })

    it("合并全量 Wiki 词典时保留本轮证据的稳定来源编号", () => {
        expect(mergeWikiMentionTargets(
            [target("entity-mole", "小鼹鼠", { aliases: ["Mole"] })],
            [target("entity-mole", "小鼹鼠", { citationIndex: 3 })],
        )).toEqual([
            target("entity-mole", "小鼹鼠", { aliases: ["Mole"], citationIndex: 3 }),
        ])
    })
})
