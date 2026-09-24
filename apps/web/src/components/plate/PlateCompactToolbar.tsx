import * as React from "react"
import { useListToolbarButton, useListToolbarButtonState } from "@platejs/list-classic/react"
import { PlaceholderPlugin } from "@platejs/media/react"
import { KEYS, type TElement } from "platejs"
import { useEditorRef, useSelectionFragmentProp } from "platejs/react"
import { useFilePicker } from "use-file-picker"

import { ImageIcon, List, ListTodo, QuoteIcon } from "@/components/iconimate"
import { getBlockType, setBlockType } from "@/components/editor/transforms-classic"
import { Toolbar, ToolbarButton } from "@/components/ui/toolbar"

function CompactListButton({ nodeType, label, children }: { nodeType: string; label: string; children: React.ReactNode }) {
    const state = useListToolbarButtonState({ nodeType })
    const { props } = useListToolbarButton(state)
    return <ToolbarButton {...props} aria-label={label} tooltip={label}>{children}</ToolbarButton>
}

function CompactQuoteButton() {
    const editor = useEditorRef()
    const blockType = useSelectionFragmentProp({ defaultValue: KEYS.p, getProp: (node) => getBlockType(node as TElement) })
    const active = blockType === KEYS.blockquote
    return (
        <ToolbarButton pressed={active} aria-label="引用" tooltip="引用"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { setBlockType(editor, active ? KEYS.p : KEYS.blockquote); editor.tf.focus() }}>
            <QuoteIcon />
        </ToolbarButton>
    )
}

function CompactImageButton() {
    const editor = useEditorRef()
    const { openFilePicker } = useFilePicker({
        accept: ["image/*"],
        multiple: true,
        onFilesSelected: ({ plainFiles }) => { editor.getTransforms(PlaceholderPlugin).insert.media(plainFiles) },
    })
    return <ToolbarButton aria-label="插入图片" tooltip="插入图片（也可直接粘贴）" onClick={() => openFilePicker()}><ImageIcon /></ToolbarButton>
}

/**
 * 轻量编辑器的底部操作条：只保留高频块操作，文字格式交给选区浮动工具栏、
 * Markdown 快捷输入与 `/` 命令；`children` 用于放置调用方自己的标签、字数和提交按钮。
 */
export function PlateCompactToolbar({ disabled, children }: { disabled?: boolean; children?: React.ReactNode }) {
    return (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 px-2 py-1.5 sm:px-3">
            {!disabled && (
                <Toolbar aria-label="常用格式" className="shrink-0 gap-0.5 text-muted-foreground">
                    <CompactListButton nodeType={KEYS.taskList} label="待办清单"><ListTodo /></CompactListButton>
                    <CompactListButton nodeType={KEYS.ulClassic} label="无序列表"><List /></CompactListButton>
                    <CompactQuoteButton />
                    <CompactImageButton />
                </Toolbar>
            )}
            {children}
        </div>
    )
}
