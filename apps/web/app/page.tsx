import type { Metadata } from "next"
import { buildStaticPublicPageMetadata } from "@/lib/public-site/metadata"
import { SpaEntry } from "./spa-entry"

export const metadata: Metadata = buildStaticPublicPageMetadata("/")

export default function HomePage() {
    return <SpaEntry />
}
