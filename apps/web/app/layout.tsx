import type { Metadata } from "next"
import { FIXED_RETYPESET_THEME_ID } from "@/lib/retypeset-themes"
import { getPublicBaseUrl, toAbsolutePublicUrl } from "@/lib/public-site/site-url"
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
    return (
        <html lang="zh-CN" suppressHydrationWarning data-retypeset-theme={FIXED_RETYPESET_THEME_ID}>
            <head>
                {/* 首屏防闪：前台公开页恒为暗色，但 .dark 由 ThemeProvider 在客户端才加，
                    SSR 首帧会先按浅色令牌绘制导致顶栏白闪。这段脚本在样式生效前就定好主题。
                    判定规则与 src/lib/public-theme-routes.ts 的 isPublicSitePathByExclusion 等价。 */}
                <script
                    dangerouslySetInnerHTML={{
                        __html: `(function(){try{var p=location.pathname.replace(/(.)\\/$/,"$1")||"/";var deny=["/dashboard","/login","/auth","/demo"];var isPublic=!deny.some(function(d){return p===d||p.indexOf(d+"/")===0});var t=isPublic?"dark":(localStorage.getItem("ui-theme")||"system");if(t==="system"){t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}document.documentElement.classList.add(t)}catch(e){}})()`,
                    }}
                />
            </head>
            <body>
                {children}
            </body>
        </html>
    )
}
