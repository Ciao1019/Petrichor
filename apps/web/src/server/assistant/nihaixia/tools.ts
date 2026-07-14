import { createTool } from "@mastra/core/tools"
import { z } from "zod"
import { grepSkill, readSkill } from "./skill-files"

// 倪海厦旁路运行时的检索工具（脱离站内业务，不需要 AssistantToolContext）。
// 仅读本地 vendored 的倪海厦讲义 markdown，供 agent 先定位行号再取原文作答。

const grepInputSchema = z.object({
    query: z.string().min(1).describe("关键词（子串匹配，大小写不敏感），如「桂枝汤」「少阴病」「失眠」"),
    file: z
        .string()
        .optional()
        .describe("可选。不传则只搜 SKILL.md（关键词索引+六经核心）；按索引提示传入具体文件深搜，如 modules/04_jingui.md、cases/01_cancer.md"),
})

const readInputSchema = z.object({
    file: z.string().min(1).describe("要读取的讲义文件，如 SKILL.md / modules/09_zhenjiu_bencao.md / cases/02_cardiovascular.md"),
    offset: z.number().int().positive().optional().describe("起始行号（1 起始），一般用 grep 返回的 line"),
    limit: z.number().int().positive().optional().describe("读取行数，默认 120，最多 400（并按字符数封顶）"),
})

export const NIHAIXIA_TOOL_NAMES = ["nihaixia_grep", "nihaixia_read"] as const

/** 构建倪海厦检索工具集（形状与 loadMastraToolsForDomains 一致，可直接挂到 Agent.tools）。 */
export function buildNihaixiaTools(): Record<string, ReturnType<typeof createTool>> {
    return {
        nihaixia_grep: createTool({
            id: "nihaixia_grep",
            description:
                "在倪海厦讲义中按关键词定位行号。不传 file 只搜 SKILL.md（关键词索引 + 六经核心）；根据索引提示传 file 深搜对应模块/医案。返回命中的 file/line/文本片段。",
            inputSchema: grepInputSchema,
            execute: async (input: unknown) => {
                const { query, file } = grepInputSchema.parse(input)
                const res = grepSkill({ query, file: file ?? null })
                if (res.matches.length === 0) {
                    return {
                        ok: true,
                        query: res.query,
                        searchedFiles: res.searchedFiles,
                        matches: [],
                        hint: file
                            ? `「${res.query}」在 ${file} 中未命中。可换关键词，或先不传 file 搜 SKILL.md 索引确认应查哪个文件。`
                            : `「${res.query}」在 SKILL.md 索引中未命中。可换近义词，或按主题猜测 module（伤寒 modules/01、金匮 modules/04、内经 modules/05/08、本草针灸 modules/09、梁冬对话 modules/06、医案 cases/*）后传 file 深搜。`,
                    }
                }
                return {
                    ok: true,
                    query: res.query,
                    searchedFiles: res.searchedFiles,
                    truncated: res.truncated,
                    matches: res.matches,
                    hint: "用 nihaixia_read 按上面的 line 取原文；SKILL.md 索引里常给出「搜索位置」，据此对 modules/* 再 grep 或 read。",
                }
            },
        }),
        nihaixia_read: createTool({
            id: "nihaixia_read",
            description:
                "读取倪海厦讲义某文件的一段原文（1 起始行号，返回带行号）。配合 nihaixia_grep 得到的行号取原文；hasMore=true 时可用新的 offset 继续翻页。",
            inputSchema: readInputSchema,
            execute: async (input: unknown) => {
                const { file, offset, limit } = readInputSchema.parse(input)
                const res = readSkill({ file, offset: offset ?? null, limit: limit ?? null })
                return { ok: true, ...res }
            },
        }),
    }
}
