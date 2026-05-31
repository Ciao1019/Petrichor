export const S4_URL_PREFIX = "s4key:"

const S4_OBJECT_KEY_PATTERN = /^\/?uploads\/\d+\/.+$/i

export function normalizeS4ObjectKey(raw: string | undefined | null): string | null {
  const value = raw?.trim()
  if (!value) return null

  const withoutPrefix = value.startsWith(S4_URL_PREFIX)
    ? value.slice(S4_URL_PREFIX.length)
    : value
  const withoutLeadingSlash = withoutPrefix.replace(/^\/+/, "")
  const objectKey = withoutLeadingSlash.split(/[?#]/)[0] ?? withoutLeadingSlash

  if (!S4_OBJECT_KEY_PATTERN.test(objectKey)) return null
  return objectKey
}

export function normalizeS4ObjectUrl(raw: string | undefined | null): string | null {
  const objectKey = normalizeS4ObjectKey(raw)
  return objectKey ? `${S4_URL_PREFIX}${objectKey}` : null
}

export function isS4ObjectUrl(raw: string | undefined | null): boolean {
  return normalizeS4ObjectKey(raw) != null
}
