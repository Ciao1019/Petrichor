import { MarkdownPlugin, parseMarkdownBlocks } from "@platejs/markdown"
import type { Value } from "platejs"
import type { PlateEditor } from "platejs/react"

function rethrow(error: Error): never {
    throw error
}

function isMdxSyntaxError(error: unknown): boolean {
    return error instanceof Error
        && "source" in error
        && typeof error.source === "string"
        && error.source.includes("mdx")
}

/** 保留正常 MDX；语法出错时按完整块恢复，避免上游把后续正文塞进列表的 children。 */
export function deserializeMarkdownWithRecovery(editor: PlateEditor, markdown: string): Value {
    const { deserialize } = editor.getApi(MarkdownPlugin).markdown
    try {
        // onError 阻止上游进入会破坏列表结构的行内恢复分支。
        return deserialize(markdown, { onError: rethrow })
    } catch (error) {
        if (!isMdxSyntaxError(error)) throw error
    }

    return parseMarkdownBlocks(markdown).flatMap(({ raw }) => {
        try {
            return deserialize(raw, { onError: rethrow })
        } catch (error) {
            if (!isMdxSyntaxError(error)) throw error
            // 仅损坏的块按普通 Markdown 恢复，前后的有效 MDX 仍由原插件处理。
            return deserialize(raw, { withoutMdx: true, onError: rethrow })
        }
    })
}
