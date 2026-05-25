const PUBLIC_LIGHT_THEME_PATHS = new Set(["/", "/about", "/tags"])

function normalizePathname(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1)
  }

  return pathname || "/"
}

export function isPublicLightThemePath(pathname: string) {
  const normalizedPathname = normalizePathname(pathname)
  return PUBLIC_LIGHT_THEME_PATHS.has(normalizedPathname) || normalizedPathname.startsWith("/p/")
}
