"use client"

import * as React from "react"

import type { DropdownMenuProps } from "@radix-ui/react-dropdown-menu"

import { SquareArrowOutUpRightIcon } from "@/components/iconimate"

import {
    EMBED_PROVIDER_CONFIG,
    EMBED_PROVIDER_ORDER,
    useEmbedCard,
} from "@/components/editor/embed-card/embed-card-insert"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { ToolbarButton } from "./toolbar"

export function EmbedCardToolbarButton(props: DropdownMenuProps) {
    const embed = useEmbedCard()
    const [open, setOpen] = React.useState(false)

    return (
        <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
            <DropdownMenuTrigger asChild>
                <ToolbarButton pressed={open} tooltip="嵌入卡片" isDropdown>
                    <SquareArrowOutUpRightIcon />
                </ToolbarButton>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="start">
                <DropdownMenuGroup>
                    {EMBED_PROVIDER_ORDER.map((provider) => {
                        const config = EMBED_PROVIDER_CONFIG[provider]
                        return (
                            <DropdownMenuItem
                                key={provider}
                                className="min-w-[180px]"
                                onSelect={() => embed.open(provider)}
                            >
                                {config.icon}
                                {config.label}
                            </DropdownMenuItem>
                        )
                    })}
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}
