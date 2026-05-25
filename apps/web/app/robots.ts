import type { MetadataRoute } from "next"

import { getPublicBaseUrl, toAbsolutePublicUrl } from "@/server/public-site/site-url"

export default function robots(): MetadataRoute.Robots {
    const baseUrl = getPublicBaseUrl()

    return {
        rules: [
            {
                userAgent: "*",
                allow: "/",
                disallow: ["/dashboard", "/dashboard/", "/login", "/auth"],
            },
        ],
        sitemap: toAbsolutePublicUrl("/sitemap.xml", baseUrl),
    }
}
