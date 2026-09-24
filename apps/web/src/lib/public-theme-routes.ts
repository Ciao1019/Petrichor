/**
 * 前台公开页使用独立的纸色配色，明暗偏好与后台共用。
 * 后台 /dashboard 不在此列，保留后台原有设计令牌。
 */
const PUBLIC_SITE_PATHS = new Set(["/", "/about", "/tags", "/graph", "/ask", "/projects", "/petrichor", "/wiki", "/search"])

function normalizePathname(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }

  return pathname || "/"
}

export function isPublicSitePath(pathname: string) {
  const normalizedPathname = normalizePathname(pathname)
  return PUBLIC_SITE_PATHS.has(normalizedPathname)
    || normalizedPathname.startsWith("/wiki/")
    || normalizedPathname.startsWith("/p/")
    || normalizedPathname.startsWith("/b/")
}

/**
 * 首屏防闪脚本用的等价判定（见 index.html）。
 * 那段脚本必须在 bundle 加载前跑，没法 import 本模块，所以改用「排除后台」的反向规则。
 * 这里导出同一份逻辑，由单测钉住两者对所有应用路由结论一致。
 */
const NON_PUBLIC_PREFIXES = ["/dashboard", "/login", "/auth", "/demo"]

export function isPublicSitePathByExclusion(pathname: string) {
  const normalizedPathname = normalizePathname(pathname)
  return !NON_PUBLIC_PREFIXES.some((prefix) =>
    normalizedPathname === prefix || normalizedPathname.startsWith(`${prefix}/`))
}
