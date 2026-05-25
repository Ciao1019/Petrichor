import type { Metadata } from "next"
import { loadPublicSiteAppearanceForFirstPaint } from "@/server/appearance/public-loader"
import {
    buildRetypesetThemeInitScript,
    resolveServerRetypesetTheme,
} from "@/server/appearance/theme-init"
import { getPublicBaseUrl, toAbsolutePublicUrl } from "@/server/public-site/site-url"
import "./globals.css"

const publicBaseUrl = getPublicBaseUrl()

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
    metadataBase: new URL(publicBaseUrl),
    title: {
        default: "Petrichor",
        template: "%s | Petrichor",
    },
    description: "Petrichor 公开文章、知识与灵感更新。",
    icons: {
        icon: [{ url: "/sidebar-logo.jpg", type: "image/jpeg" }],
    },
    alternates: {
        canonical: toAbsolutePublicUrl("/", publicBaseUrl),
        types: {
            "application/atom+xml": toAbsolutePublicUrl("/atom.xml", publicBaseUrl),
            "application/rss+xml": toAbsolutePublicUrl("/rss.xml", publicBaseUrl),
        },
    },
    openGraph: {
        title: "Petrichor",
        description: "Petrichor 公开文章、知识与灵感更新。",
        url: toAbsolutePublicUrl("/", publicBaseUrl),
        siteName: "Petrichor",
        locale: "zh_CN",
        type: "website",
    },
    twitter: {
        card: "summary",
        title: "Petrichor",
        description: "Petrichor 公开文章、知识与灵感更新。",
    },
}

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode
}>) {
    const appearance = await loadPublicSiteAppearanceForFirstPaint()
    return (
        <html lang="zh-CN" suppressHydrationWarning data-retypeset-theme={resolveServerRetypesetTheme(appearance)}>
            <head>
                <script
                    id="retypeset-theme-init"
                    dangerouslySetInnerHTML={{ __html: buildRetypesetThemeInitScript(appearance) }}
                />
            </head>
            <body>
                {children}
            </body>
        </html>
    )
}
