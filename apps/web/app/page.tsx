import type { Metadata } from "next"
import { loadPublicSiteAppearanceForFirstPaint } from "@/server/appearance/public-loader"
import { buildStaticPublicPageMetadata } from "@/server/public-site/metadata"
import { SpaEntry } from "./spa-entry"

export const metadata: Metadata = buildStaticPublicPageMetadata("/")

export default async function HomePage() {
    const initialAppearance = await loadPublicSiteAppearanceForFirstPaint()
    return <SpaEntry initialAppearance={initialAppearance} />
}
