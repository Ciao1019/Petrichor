import type { Metadata } from "next"
import { resolvePublicRouteMetadata } from "@/lib/public-site/metadata"
import { fetchPublicArticlesFromGo } from "@/lib/public-site/articles"
import { SpaEntry } from "../spa-entry"

type CatchAllParams = {
    path?: string[]
}

type CatchAllPageProps = {
    params: Promise<CatchAllParams>
}

export async function generateMetadata({ params }: CatchAllPageProps): Promise<Metadata> {
    const resolvedParams = await params
    const pathSegments = resolvedParams.path ?? []
    const articles = pathSegments[0] === "p"
        ? await fetchPublicArticlesFromGo()
        : []

    return resolvePublicRouteMetadata(pathSegments, articles)
}

export default function CatchAllPage() {
    return <SpaEntry />
}
