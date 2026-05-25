"use client"

import dynamic from "next/dynamic"
import type { RetypesetAppearanceConfig } from "@/lib/retypeset-themes"

type SpaEntryProps = {
    initialAppearance?: RetypesetAppearanceConfig
}

const App = dynamic<SpaEntryProps>(() => import("@/client-app"), {
    ssr: false,
})

export function SpaEntry({ initialAppearance }: SpaEntryProps) {
    return <App initialAppearance={initialAppearance} />
}
