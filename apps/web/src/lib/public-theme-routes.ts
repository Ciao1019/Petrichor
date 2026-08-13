/**
 * 前台公开页统一强制暗色主题（配色对齐后台右侧内容区），不再提供浅色版本。
 * 后台 /dashboard 不在此列，仍由用户自行切换明暗。
 */
const PUBLIC_SITE_PATHS = new Set(["/", "/about", "/tags", "/ask", "/projects", "/petrichor"])

function normalizePathname(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }

  return pathname || "/"
}

export function isPublicSitePath(pathname: string) {
  const normalizedPathname = normalizePathname(pathname)
  return PUBLIC_SITE_PATHS.has(normalizedPathname)
    || normalizedPathname.startsWith("/p/")
    || normalizedPathname.startsWith("/b/")
}

/**
 * 首屏防闪脚本用的等价判定（见 app/layout.tsx）。
 * 那段脚本必须在 bundle 加载前跑，没法 import 本模块，所以改用「排除后台」的反向规则。
 * 这里导出同一份逻辑，由单测钉住两者对所有应用路由结论一致。
 */
const NON_PUBLIC_PREFIXES = ["/dashboard", "/login", "/auth", "/demo"]

export function isPublicSitePathByExclusion(pathname: string) {
  const normalizedPathname = normalizePathname(pathname)
  return !NON_PUBLIC_PREFIXES.some((prefix) =>
    normalizedPathname === prefix || normalizedPathname.startsWith(`${prefix}/`))
}
