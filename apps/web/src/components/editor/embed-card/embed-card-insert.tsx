"use client"

import * as React from "react"
import { AppWindowIcon, GithubIcon, MusicIcon, TwitterIcon } from "@/components/iconimate"
import { useEditorRef } from "platejs/react"
import { toast } from "sonner"

import {
    EMBED_CARD_TYPE,
    type EmbedCardElement,
    type EmbedCardProvider,
    getHtmlEmbedSrc,
    getSpotifyEmbedUrl,
    getTweetId,
    normalizeGitHubRepo,
} from "@/components/plate/plate-embed-directives"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Input } from "@/components/ui/input"

// ---------------------------------------------------------------------------
// Provider 配置：每种嵌入卡片的标题、字段、占位符与校验
// ---------------------------------------------------------------------------

type EmbedFieldKind = "url" | "repo"

type EmbedProviderConfig = {
    field: EmbedFieldKind
    icon: React.ReactNode
    label: string
    placeholder: string
    title: string
    /** 校验并归一化输入；返回 null 表示无效 */
    normalize: (value: string) => string | null
}

export const EMBED_PROVIDER_CONFIG: Record<EmbedCardProvider, EmbedProviderConfig> = {
    github: {
        field: "repo",
        icon: <GithubIcon />,
        label: "GitHub",
        placeholder: "owner/repo 或 https://github.com/owner/repo",
        title: "插入 GitHub 仓库卡片",
        normalize: (value) => normalizeGitHubRepo(value),
    },
    tweet: {
        field: "url",
        icon: <TwitterIcon />,
        label: "X / Twitter",
        placeholder: "https://x.com/用户/status/...",
        title: "插入 X / Twitter 卡片",
        normalize: (value) => {
            const url = value.trim()
            return url && getTweetId(url) ? url : null
        },
    },
    spotify: {
        field: "url",
        icon: <MusicIcon />,
        label: "Spotify",
        placeholder: "https://open.spotify.com/track/...",
        title: "插入 Spotify 卡片",
        normalize: (value) => {
            const url = value.trim()
            return url && getSpotifyEmbedUrl(url) ? url : null
        },
    },
    html: {
        field: "url",
        icon: <AppWindowIcon />,
        label: "HTML 可视化",
        placeholder: "/tools/visualizations/architecture.html",
        title: "插入自托管 HTML 可视化",
        normalize: (value) => getHtmlEmbedSrc(value),
    },
}

export const EMBED_PROVIDER_ORDER: EmbedCardProvider[] = ["github", "tweet", "spotify", "html"]

// ---------------------------------------------------------------------------
// 模块级 store：与 AI 助手一致，避开浮动工具栏 / portal 的 context 传播问题
// ---------------------------------------------------------------------------

type EmbedDialogState = {
    isOpen: boolean
    provider: EmbedCardProvider | null
}

const CLOSED_STATE: EmbedDialogState = { isOpen: false, provider: null }

let currentState: EmbedDialogState = CLOSED_STATE
const listeners = new Set<() => void>()

function emit() {
    for (const listener of listeners) listener()
}

export function openEmbedCardDialog(provider: EmbedCardProvider) {
    currentState = { isOpen: true, provider }
    emit()
}

export function closeEmbedCardDialog() {
    if (!currentState.isOpen) return
    currentState = CLOSED_STATE
    emit()
}

function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

function getSnapshot() {
    return currentState
}

function getServerSnapshot() {
    return CLOSED_STATE
}

function useEmbedDialogState() {
    return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export interface EmbedCardControls {
    open: (provider: EmbedCardProvider) => void
}

const controls: EmbedCardControls = { open: openEmbedCardDialog }

// 永远返回可用 controls —— 可在编辑器树任意位置调用（含浮动工具栏 / portal）
export function useEmbedCard(): EmbedCardControls {
    return controls
}

// ---------------------------------------------------------------------------
// 弹窗组件
// ---------------------------------------------------------------------------

function EmbedCardDialogBody({
    provider,
    onClose,
}: {
    provider: EmbedCardProvider
    onClose: () => void
}) {
    const editor = useEditorRef()
    const config = EMBED_PROVIDER_CONFIG[provider]
    const [value, setValue] = React.useState("")

    const insert = React.useCallback(() => {
        const normalized = config.normalize(value)
        if (!normalized) {
            toast.error("链接格式无效")
            return
        }

        const node: EmbedCardElement = {
            type: EMBED_CARD_TYPE,
            provider,
            ...(config.field === "repo"
                ? { repo: normalized }
                : { url: normalized }),
            children: [{ text: "" }],
        }

        onClose()
        editor.tf.insertNodes(node, { select: true })
        editor.tf.focus()
    }, [config, editor, onClose, provider, value])

    return (
        <>
            <AlertDialogHeader>
                <AlertDialogTitle>{config.title}</AlertDialogTitle>
            </AlertDialogHeader>

            <AlertDialogDescription asChild>
                <div className="w-full">
                    <Input
                        autoFocus
                        className="w-full"
                        onChange={(event) => setValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.preventDefault()
                                insert()
                            }
                        }}
                        placeholder={config.placeholder}
                        value={value}
                    />
                </div>
            </AlertDialogDescription>

            <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction
                    onClick={(event) => {
                        event.preventDefault()
                        insert()
                    }}
                >
                    插入卡片
                </AlertDialogAction>
            </AlertDialogFooter>
        </>
    )
}

export function EmbedCardDialog() {
    const state = useEmbedDialogState()

    React.useEffect(() => {
        // 编辑器卸载时清理悬挂状态，避免下次进入残留
        return () => closeEmbedCardDialog()
    }, [])

    return (
        <AlertDialog
            open={state.isOpen}
            onOpenChange={(open) => {
                if (!open) closeEmbedCardDialog()
            }}
        >
            <AlertDialogContent className="gap-6">
                {state.provider ? (
                    <EmbedCardDialogBody
                        key={state.provider}
                        provider={state.provider}
                        onClose={closeEmbedCardDialog}
                    />
                ) : null}
            </AlertDialogContent>
        </AlertDialog>
    )
}
