import { defineCloudflareConfig } from "@opennextjs/cloudflare"

// OpenNext for Cloudflare 适配配置。
// 默认不启用增量缓存（incrementalCache = "dummy"），开箱即可部署。
//
// 如需 ISR / fetch 缓存，安装并启用 R2 缓存：
//   import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache"
//   export default defineCloudflareConfig({ incrementalCache: r2IncrementalCache })
// 并在 wrangler.jsonc 中放开 NEXT_INC_CACHE_R2_BUCKET 绑定。
const config = defineCloudflareConfig()

// Next 16 的 `next build` 默认用 Turbopack，而 Turbopack 把 CSS 产物放进
// `.next/static/chunks/*.css`，OpenNext (@opennextjs/aws) 的资源拷贝逻辑却硬编码
// 去找 `.next/static/css`，会直接 ENOENT 挂掉。强制走 webpack 构建即可对齐布局。
export default {
    ...config,
    buildCommand: "next build --webpack",
}
