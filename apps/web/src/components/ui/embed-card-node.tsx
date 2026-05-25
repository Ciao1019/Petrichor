"use client"

import * as React from "react"
import { Tweet } from "react-tweet"
import { ExternalLinkIcon, GithubIcon, GitForkIcon, ScaleIcon, StarIcon } from "lucide-react"
import type { PlateElementProps } from "platejs/react"
import { PlateElement } from "platejs/react"

import {
    type EmbedCardElement as TEmbedCardElement,
    getGitHubRepoUrl,
    getSpotifyEmbedHeight,
    getSpotifyEmbedUrl,
    getTweetId,
    normalizeGitHubRepo,
} from "@/components/plate/plate-embed-directives"
import { cn } from "@/lib/utils"

type GitHubRepoResponse = {
    description: string | null
    forks_count: number
    full_name: string
    html_url: string
    license: { spdx_id: string | null } | null
    name: string
    owner: {
        avatar_url: string
        login: string
    }
    stargazers_count: number
}

function formatCount(value: number) {
    return new Intl.NumberFormat("en", {
        maximumFractionDigits: 1,
        notation: value >= 10_000 ? "compact" : "standard",
    }).format(value)
}

function EmbedCardShell({
    children,
    className,
    href,
}: {
    children: React.ReactNode
    className?: string
    href?: string | null
}) {
    const content = (
        <div
            className={cn(
                "not-prose my-3 w-full max-w-[46rem] rounded-lg border bg-card text-card-foreground shadow-sm",
                className
            )}
        >
            {children}
        </div>
    )

    if (!href) return content

    return (
        <a
            className="block w-fit max-w-full text-inherit no-underline"
            href={href}
            rel="noreferrer"
            target="_blank"
        >
            {content}
        </a>
    )
}

function InvalidEmbedCard({ label }: { label: string }) {
    return (
        <EmbedCardShell className="px-4 py-3 text-sm text-muted-foreground">
            无法渲染 {label} 卡片
        </EmbedCardShell>
    )
}

function TweetEmbedCard({ url }: { url?: string }) {
    const tweetId = url ? getTweetId(url) : null
    if (!tweetId) return <InvalidEmbedCard label="Tweet" />

    return (
        <div className="not-prose my-3 max-w-[550px] [&_.react-tweet-theme]:my-0">
            <Tweet id={tweetId} />
        </div>
    )
}

function SpotifyEmbedCard({ url }: { url?: string }) {
    const embedUrl = url ? getSpotifyEmbedUrl(url) : null
    if (!embedUrl) return <InvalidEmbedCard label="Spotify" />

    return (
        <div className="not-prose my-3 w-full max-w-[46rem] overflow-hidden rounded-lg">
            <iframe
                allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
                className="block w-full border-0"
                height={getSpotifyEmbedHeight(url ?? "")}
                loading="lazy"
                src={embedUrl}
                title="Spotify embed"
            />
        </div>
    )
}

function GitHubFallbackCard({ repo }: { repo: string }) {
    const repoUrl = getGitHubRepoUrl(repo)
    const normalized = normalizeGitHubRepo(repo) ?? repo
    const [owner, name] = normalized.split("/")

    return (
        <EmbedCardShell href={repoUrl}>
            <div className="flex items-start justify-between gap-4 px-4 py-4">
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2 text-base">
                        <GithubIcon className="size-5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-muted-foreground">{owner}</span>
                        <span className="text-muted-foreground">/</span>
                        <span className="truncate font-semibold">{name}</span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                        点击查看 GitHub 仓库
                    </p>
                </div>
                <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" />
            </div>
        </EmbedCardShell>
    )
}

function GitHubEmbedCard({ repo }: { repo?: string }) {
    const normalizedRepo = repo ? normalizeGitHubRepo(repo) : null
    const [data, setData] = React.useState<GitHubRepoResponse | null>(null)
    const [failed, setFailed] = React.useState(false)

    React.useEffect(() => {
        if (!normalizedRepo) return

        const controller = new AbortController()
        setData(null)
        setFailed(false)

        fetch(`https://api.github.com/repos/${normalizedRepo}`, {
            headers: { Accept: "application/vnd.github+json" },
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) throw new Error(`GitHub API ${response.status}`)
                return (await response.json()) as GitHubRepoResponse
            })
            .then((nextData) => {
                setData(nextData)
            })
            .catch((error: unknown) => {
                if (error instanceof DOMException && error.name === "AbortError") return
                setFailed(true)
            })

        return () => controller.abort()
    }, [normalizedRepo])

    if (!normalizedRepo) return <InvalidEmbedCard label="GitHub" />
    if (failed || !data) return <GitHubFallbackCard repo={normalizedRepo} />

    return (
        <EmbedCardShell href={data.html_url}>
            <div className="flex items-start justify-between gap-4 px-4 py-4 sm:px-5">
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-3">
                        <img
                            alt=""
                            className="size-9 shrink-0 rounded-full bg-muted object-cover"
                            loading="lazy"
                            src={data.owner.avatar_url}
                        />
                        <div className="min-w-0 text-lg leading-tight">
                            <span className="truncate text-muted-foreground">{data.owner.login}</span>
                            <span className="mx-1 text-muted-foreground">/</span>
                            <span className="font-semibold">{data.name}</span>
                        </div>
                    </div>

                    {data.description && (
                        <p className="mt-4 line-clamp-2 text-base leading-7 text-muted-foreground">
                            {data.description}
                        </p>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-2">
                            <StarIcon className="size-4" />
                            {formatCount(data.stargazers_count)}
                        </span>
                        <span className="inline-flex items-center gap-2">
                            <GitForkIcon className="size-4" />
                            {formatCount(data.forks_count)}
                        </span>
                        {data.license?.spdx_id && (
                            <span className="inline-flex items-center gap-2">
                                <ScaleIcon className="size-4" />
                                {data.license.spdx_id}
                            </span>
                        )}
                    </div>
                </div>
                <GithubIcon className="mt-1 size-7 shrink-0 text-muted-foreground" />
            </div>
        </EmbedCardShell>
    )
}

export function EmbedCardElement(props: PlateElementProps<TEmbedCardElement>) {
    const { provider, repo, url } = props.element

    return (
        <PlateElement className="py-2.5" {...props}>
            <figure className="m-0 w-full cursor-default" contentEditable={false}>
                {provider === "tweet" ? (
                    <TweetEmbedCard url={url} />
                ) : provider === "github" ? (
                    <GitHubEmbedCard repo={repo} />
                ) : provider === "spotify" ? (
                    <SpotifyEmbedCard url={url} />
                ) : (
                    <InvalidEmbedCard label="嵌入" />
                )}
            </figure>
            {props.children}
        </PlateElement>
    )
}
