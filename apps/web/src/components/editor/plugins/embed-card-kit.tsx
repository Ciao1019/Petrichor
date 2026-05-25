"use client"

import { createPlatePlugin } from "platejs/react"

import { EMBED_CARD_TYPE } from "@/components/plate/plate-embed-directives"
import { EmbedCardElement } from "@/components/ui/embed-card-node"

export const EmbedCardPlugin = createPlatePlugin({
    key: EMBED_CARD_TYPE,
    node: {
        component: EmbedCardElement,
        isElement: true,
        isVoid: true,
    },
})

export const EmbedCardKit = [EmbedCardPlugin]
