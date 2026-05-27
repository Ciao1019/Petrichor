import * as React from "react"
import { toast } from "sonner"

import { knowledgeBaseArticleShareApi } from "@/lib/api"
import {
  buildShareState,
  DEFAULT_PIN_ORDER,
  isValidHttpUrl,
  OTP_LENGTH,
  resolveAxiosErrorMessage,
  safeOrigin,
  toLocalDateTimeString,
} from "@/components/knowledge/article-share-utils"

type UseArticleShareDialogStateOptions = {
  open: boolean
  articleId?: string
}

const EXPIRE_AT_END_HOUR = 23
const EXPIRE_AT_END_MINUTE = 59
const EXPIRE_AT_END_SECOND = 59

function toExpireAtDate(date: Date | null): Date | null {
  if (!date) return null
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    EXPIRE_AT_END_HOUR,
    EXPIRE_AT_END_MINUTE,
    EXPIRE_AT_END_SECOND,
    0,
  )
}

export function toDateKey(date: Date | null): string | undefined {
  if (!date) return undefined
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function parseDateKey(dateKey: string): Date | null {
  const [yearRaw, monthRaw, dayRaw] = dateKey.split("-")
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)
  if (!year || !month || !day) return null
  return new Date(year, month - 1, day)
}

export function useArticleShareDialogState({ open, articleId }: UseArticleShareDialogStateOptions) {
  const [loadingInfo, setLoadingInfo] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [revoking, setRevoking] = React.useState(false)
  const [pinSubmitting, setPinSubmitting] = React.useState(false)

  const [shareCode, setShareCode] = React.useState<string | null>(null)
  const [hasPassword, setHasPassword] = React.useState(false)
  const [enableExpire, setEnableExpire] = React.useState(false)
  const [expireDate, setExpireDate] = React.useState<Date | null>(new Date())
  const [usePassword, setUsePassword] = React.useState(false)
  const [editingPassword, setEditingPassword] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [isRepost, setIsRepost] = React.useState(false)
  const [originalUrl, setOriginalUrl] = React.useState("")
  const [originalAuthorName, setOriginalAuthorName] = React.useState("")
  const [isPinned, setIsPinned] = React.useState(false)
  const [pinOrder, setPinOrder] = React.useState<number>(DEFAULT_PIN_ORDER)

  const shareUrl = React.useMemo(() => {
    if (!shareCode) return ""
    const origin = safeOrigin()
    return origin ? `${origin}/p/${shareCode}` : `/p/${shareCode}`
  }, [shareCode])

  const expireEcho = React.useMemo(() => {
    const expiresAtDate = toExpireAtDate(expireDate)
    if (!expiresAtDate) return ""
    return toLocalDateTimeString(expiresAtDate).replace("T", " ")
  }, [expireDate])

  React.useEffect(() => {
    if (!open || !articleId) return
    let canceled = false
    setLoadingInfo(true)

    knowledgeBaseArticleShareApi
      .info({ articleId })
      .then((res) => {
        if (canceled) return
        const next = buildShareState(res.data)
        setShareCode(next.shareCode)
        setHasPassword(next.hasPassword)
        setUsePassword(next.usePassword)
        setEnableExpire(next.enableExpire)
        setExpireDate(next.expireDate)
        setEditingPassword(next.usePassword && !next.hasPassword)
        setPassword("")
        setIsRepost(next.isRepost)
        setOriginalUrl(next.originalUrl)
        setOriginalAuthorName(next.originalAuthorName)
        setIsPinned(next.isPinned)
        setPinOrder(next.pinOrder ?? DEFAULT_PIN_ORDER)
      })
      .catch((e) => {
        if (canceled) return
        toast(resolveAxiosErrorMessage(e, "加载分享信息失败"))
      })
      .finally(() => {
        if (canceled) return
        setLoadingInfo(false)
      })

    return () => {
      canceled = true
    }
  }, [articleId, open])

  const setUsePasswordChecked = React.useCallback((checked: boolean) => {
    setUsePassword(checked)
    if (!checked) {
      setEditingPassword(false)
      setPassword("")
      return
    }
    if (hasPassword) {
      setEditingPassword(false)
      setPassword("")
      return
    }
    setEditingPassword(true)
  }, [hasPassword])

  const setIsRepostChecked = React.useCallback((checked: boolean) => {
    setIsRepost(checked)
    if (!checked) {
      setOriginalUrl("")
      setOriginalAuthorName("")
    }
  }, [])

  const saveShareSettings = React.useCallback(async (successText: string) => {
    if (!articleId) {
      toast("缺少文章ID，无法分享")
      return false
    }

    const expiresAtDate = enableExpire ? toExpireAtDate(expireDate) : null
    if (enableExpire && !expiresAtDate) {
      toast("请选择有效的到期时间")
      return false
    }

    if (usePassword) {
      const requireNewPassword = !hasPassword || editingPassword
      if (requireNewPassword && password.length !== OTP_LENGTH) {
        toast("请填写 6 位访问密码")
        return false
      }
    }

    const normalizedOriginalUrl = originalUrl.trim()
    const normalizedOriginalAuthorName = originalAuthorName.trim()
    if (isRepost) {
      if (!normalizedOriginalUrl) {
        toast("请填写原文链接")
        return false
      }
      if (!isValidHttpUrl(normalizedOriginalUrl)) {
        toast("原文链接必须是有效的 http:// 或 https:// 地址")
        return false
      }
      if (!normalizedOriginalAuthorName) {
        toast("请填写原作者名称")
        return false
      }
    }

    setSubmitting(true)
    try {
      const res = await knowledgeBaseArticleShareApi.create({
        articleId,
        expiresAt: expiresAtDate ? toLocalDateTimeString(expiresAtDate) : null,
        passwordEnabled: usePassword,
        accessPassword: usePassword && editingPassword ? password : null,
        isRepost,
        originalUrl: isRepost ? normalizedOriginalUrl : null,
        originalAuthorName: isRepost ? normalizedOriginalAuthorName : null,
      })
      const next = buildShareState(res.data)
      setShareCode(next.shareCode)
      setHasPassword(next.hasPassword)
      setUsePassword(next.usePassword)
      setEnableExpire(next.enableExpire)
      setExpireDate(next.expireDate)
      setEditingPassword(next.usePassword && !next.hasPassword)
      setPassword("")
      setIsRepost(next.isRepost)
      setOriginalUrl(next.originalUrl)
      setOriginalAuthorName(next.originalAuthorName)
      toast(successText)
      return true
    } catch (e: unknown) {
      toast(resolveAxiosErrorMessage(e, "保存分享设置失败"))
      return false
    } finally {
      setSubmitting(false)
    }
  }, [articleId, editingPassword, enableExpire, expireDate, hasPassword, isRepost, originalAuthorName, originalUrl, password, usePassword])

  const revokeShare = React.useCallback(async () => {
    if (!articleId) {
      toast("缺少文章ID，无法撤销")
      return false
    }

    setRevoking(true)
    try {
      await knowledgeBaseArticleShareApi.revoke({ articleId })
      setShareCode(null)
      setHasPassword(false)
      setUsePassword(false)
      setEnableExpire(false)
      setEditingPassword(false)
      setPassword("")
      setIsRepost(false)
      setOriginalUrl("")
      setOriginalAuthorName("")
      setIsPinned(false)
      setPinOrder(DEFAULT_PIN_ORDER)
      toast("已撤销分享")
      return true
    } catch (e: unknown) {
      toast(resolveAxiosErrorMessage(e, "撤销分享失败"))
      return false
    } finally {
      setRevoking(false)
    }
  }, [articleId])

  const savePinSettings = React.useCallback(async () => {
    if (!articleId) {
      toast("缺少文章ID，无法置顶")
      return false
    }
    if (!shareCode) {
      toast("请先生成公开链接,再设置置顶")
      return false
    }
    const nextPinOrder = isPinned ? Math.max(0, Math.floor(Number.isFinite(pinOrder) ? pinOrder : DEFAULT_PIN_ORDER)) : null
    setPinSubmitting(true)
    try {
      const res = await knowledgeBaseArticleShareApi.setPin({ articleId, pinOrder: nextPinOrder })
      setIsPinned(res.data.isPinned)
      setPinOrder(res.data.pinOrder ?? DEFAULT_PIN_ORDER)
      toast(res.data.isPinned ? "已置顶" : "已取消置顶")
      return true
    } catch (e: unknown) {
      toast(resolveAxiosErrorMessage(e, "保存置顶设置失败"))
      return false
    } finally {
      setPinSubmitting(false)
    }
  }, [articleId, shareCode, isPinned, pinOrder])

  const copyShareLink = React.useCallback(async () => {
    if (!shareUrl) return
    await navigator.clipboard.writeText(shareUrl)
    toast("链接已复制")
  }, [shareUrl])

  return {
    loadingInfo,
    submitting,
    revoking,
    pinSubmitting,
    shareCode,
    hasPassword,
    enableExpire,
    expireDate,
    usePassword,
    editingPassword,
    password,
    isRepost,
    originalUrl,
    originalAuthorName,
    isPinned,
    pinOrder,
    shareUrl,
    expireEcho,
    setEnableExpire,
    setExpireDate,
    setUsePasswordChecked,
    setIsRepostChecked,
    setEditingPassword,
    setPassword,
    setOriginalUrl,
    setOriginalAuthorName,
    setIsPinned,
    setPinOrder,
    saveShareSettings,
    revokeShare,
    copyShareLink,
    savePinSettings,
  }
}
