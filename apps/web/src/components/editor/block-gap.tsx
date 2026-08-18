"use client"

import * as React from "react"
import { PlusIcon } from "@/components/iconimate"
import { KEYS, PathApi, type TElement } from "platejs"
import { useEditorRef, useReadOnly } from "platejs/react"

import { cn } from "@/lib/utils"

/**
 * void 块(如嵌入卡片)之间没有可编辑落点,光标进不去也就无法在两块之间另起一行。
 * 这个热区贴在 void 块的上 / 下边缘:悬停时光标变小手并显示一条带「+」的提示线,
 * 点击即在对应位置插入一个空段落并把光标移入,解决「组件与组件 / 组件与文字之间
 * 想插入空行」的问题。
 *
 * 用法:把 void 节点最外层容器设为 `relative`,在内部渲染
 * `<BlockGapInsert element={element} position="top" />` 和 `position="bottom"`。
 */
export function BlockGapInsert({
    element,
    position,
    className,
}: {
    element: TElement
    position: "top" | "bottom"
    className?: string
}) {
    const editor = useEditorRef()
    const readOnly = useReadOnly()

    const insertEmptyLine = React.useCallback(
        (event: React.MouseEvent) => {
            // 用 mousedown + preventDefault 避免编辑器先失焦 / 改变选区
            event.preventDefault()
            event.stopPropagation()

            const path = editor.api.findPath(element)
            if (!path) return

            const at = position === "top" ? path : PathApi.next(path)
            editor.tf.insertNodes(
                { type: KEYS.p, children: [{ text: "" }] },
                { at, select: true }
            )
            editor.tf.focus()
        },
        [editor, element, position]
    )

    if (readOnly) return null

    return (
        <div
            aria-label="插入空行"
            className={cn(
                "absolute inset-x-0 z-10 flex h-6 cursor-pointer items-center justify-center opacity-0 transition-opacity hover:opacity-100",
                position === "top" ? "-top-3" : "-bottom-3",
                className
            )}
            contentEditable={false}
            onMouseDown={insertEmptyLine}
            role="button"
        >
            <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-brand/40" />
            <span className="pointer-events-none relative flex size-5 items-center justify-center rounded-full border border-brand/40 bg-background text-brand shadow-sm">
                <PlusIcon className="size-3.5" />
            </span>
        </div>
    )
}
