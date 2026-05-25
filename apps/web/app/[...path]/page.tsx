import type { Metadata } from "next"
import { loadPublicSiteAppearanceForFirstPaint } from "@/server/appearance/public-loader"
import { loadPublicSiteArticles } from "@/server/public-site/articles"
import { resolvePublicRouteMetadata } from "@/server/public-site/metadata"
import { SpaEntry } from "../spa-entry"

type CatchAllParams = {
    path?: string[]
}

type CatchAllPageProps = {
    params: CatchAllParams | Promise<CatchAllParams>
}

export async function generateMetadata({ params }: CatchAllPageProps): Promise<Metadata> {
    const resolvedParams = await params
    const pathSegments = resolvedParams.path ?? []
    const articles = pathSegments[0] === "p"
        ? await loadPublicSiteArticles({ includeNonIndexable: true })
        : []

    return resolvePublicRouteMetadata(pathSegments, articles)
}

export default async function CatchAllPage() {
    const initialAppearance = await loadPublicSiteAppearanceForFirstPaint()
    return <SpaEntry initialAppearance={initialAppearance} />
}
