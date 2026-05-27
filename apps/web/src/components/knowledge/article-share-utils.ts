import type { ArticleShareCreateResponse, ArticleShareInfoResponse } from "@/lib/api"

export const OTP_LENGTH = 6

export type ShareStateSnapshot = {
  shareCode: string | null
  hasPassword: boolean
  usePassword: boolean
  enableExpire: boolean
  expireDate: Date | null
  isRepost: boolean
  originalUrl: string
  originalAuthorName: string
  isPinned: boolean
  pinOrder: number | null
}

export const DEFAULT_PIN_ORDER = 100

export function parseApiDate(value?: string | null): Date | null {
  if (!value) return null
  const normalized = value.includes("T") ? value : value.replace(" ", "T")
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return null
  return date
}

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}

export function toLocalDateTimeString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function safeOrigin(): string {
  if (typeof window === "undefined") return ""
  return window.location.origin
}

export function resolveAxiosErrorMessage(e: unknown, fallback: string): string {
  if (typeof e === "object" && e && "response" in e) {
    const response = (e as { response?: { data?: { msg?: unknown } } }).response
    const apiMsg = response?.data?.msg
    if (typeof apiMsg === "string" && apiMsg) return apiMsg
  }
  if (e instanceof Error && e.message) return e.message
  return fallback
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function buildShareState(info: ArticleShareInfoResponse | ArticleShareCreateResponse): ShareStateSnapshot {
  const code = "shareCode" in info && info.shareCode ? info.shareCode : null
  const enabled = Boolean(info.enabled)
  const hasPassword = Boolean(info.hasPassword)
  const expiresAt = parseApiDate(info.expiresAt)
  const expireDate = expiresAt
    ? new Date(expiresAt.getFullYear(), expiresAt.getMonth(), expiresAt.getDate())
    : new Date()
  const originalUrl = info.originalUrl?.trim() || ""
  const originalAuthorName = info.originalAuthorName?.trim() || ""
  const isRepost = Boolean(info.isRepost && originalUrl && originalAuthorName)
  const pinOrder = "pinOrder" in info && typeof info.pinOrder === "number" ? info.pinOrder : null
  const isPinned = pinOrder != null

  return {
    shareCode: enabled ? code : null,
    hasPassword,
    usePassword: hasPassword,
    enableExpire: Boolean(expiresAt),
    expireDate,
    isRepost,
    originalUrl: isRepost ? originalUrl : "",
    originalAuthorName: isRepost ? originalAuthorName : "",
    isPinned,
    pinOrder,
  }
}
