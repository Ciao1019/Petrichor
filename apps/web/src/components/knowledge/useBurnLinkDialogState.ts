import * as React from "react"
import { toast } from "sonner"

import { knowledgeBaseArticleBurnLinkApi, type BurnLinkRecordResponse } from "@/lib/api"
import {
  OTP_LENGTH,
  resolveAxiosErrorMessage,
  safeOrigin,
  toLocalDateTimeString,
} from "@/components/knowledge/article-share-utils"

type UseBurnLinkDialogStateOptions = {
  open: boolean
  articleId?: string
}

const EXPIRE_AT_END_HOUR = 23
const EXPIRE_AT_END_MINUTE = 59
const EXPIRE_AT_END_SECOND = 59

export const BURN_MAX_VIEWS_LIMIT = 100

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

export function burnLinkUrl(linkCode: string): string {
  const origin = safeOrigin()
  return origin ? `${origin}/b/${linkCode}` : `/b/${linkCode}`
}

export function useBurnLinkDialogState({ open, articleId }: UseBurnLinkDialogStateOptions) {
  const [loadingList, setLoadingList] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [revokingId, setRevokingId] = React.useState<string | null>(null)
  const [links, setLinks] = React.useState<BurnLinkRecordResponse[]>([])

  const [maxViews, setMaxViews] = React.useState(1)
  const [usePassword, setUsePassword] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [enableExpire, setEnableExpire] = React.useState(false)
  const [expireDate, setExpireDate] = React.useState<Date | null>(new Date())

  const resetForm = React.useCallback(() => {
    setMaxViews(1)
    setUsePassword(false)
    setPassword("")
    setEnableExpire(false)
    setExpireDate(new Date())
  }, [])

  React.useEffect(() => {
    if (!open || !articleId) return
    let canceled = false
    setLoadingList(true)
    resetForm()

    knowledgeBaseArticleBurnLinkApi
      .list({ articleId })
      .then((res) => {
        if (canceled) return
        setLinks(res.data.items)
      })
      .catch((e) => {
        if (canceled) return
        toast(resolveAxiosErrorMessage(e, "加载阅后即焚链接失败"))
      })
      .finally(() => {
        if (canceled) return
        setLoadingList(false)
      })

    return () => {
      canceled = true
    }
  }, [articleId, open, resetForm])

  const setUsePasswordChecked = React.useCallback((checked: boolean) => {
    setUsePassword(checked)
    if (!checked) setPassword("")
  }, [])

  const createLink = React.useCallback(async () => {
    if (!articleId) {
      toast("缺少文章ID，无法创建")
      return false
    }
    const normalizedMaxViews = Math.min(Math.max(Math.floor(maxViews), 1), BURN_MAX_VIEWS_LIMIT)
    if (usePassword && password.length !== OTP_LENGTH) {
      toast("请填写 6 位访问密码")
      return false
    }
    const expiresAtDate = enableExpire ? toExpireAtDate(expireDate) : null
    if (enableExpire && !expiresAtDate) {
      toast("请选择有效的到期时间")
      return false
    }

    setCreating(true)
    try {
      const res = await knowledgeBaseArticleBurnLinkApi.create({
        articleId,
        maxViews: normalizedMaxViews,
        passwordEnabled: usePassword,
        accessPassword: usePassword ? password : null,
        expiresAt: expiresAtDate ? toLocalDateTimeString(expiresAtDate) : null,
      })
      setLinks((prev) => [res.data, ...prev])
      resetForm()
      toast("已生成阅后即焚链接")
      return true
    } catch (e: unknown) {
      toast(resolveAxiosErrorMessage(e, "创建阅后即焚链接失败"))
      return false
    } finally {
      setCreating(false)
    }
  }, [articleId, enableExpire, expireDate, maxViews, password, resetForm, usePassword])

  const revokeLink = React.useCallback(async (id: string) => {
    setRevokingId(id)
    try {
      const res = await knowledgeBaseArticleBurnLinkApi.revoke({ id })
      setLinks((prev) => prev.map((link) => (link.id === id ? res.data : link)))
      toast("已撤销链接")
      return true
    } catch (e: unknown) {
      toast(resolveAxiosErrorMessage(e, "撤销链接失败"))
      return false
    } finally {
      setRevokingId(null)
    }
  }, [])

  const copyLink = React.useCallback(async (linkCode: string) => {
    const url = burnLinkUrl(linkCode)
    await navigator.clipboard.writeText(url)
    toast("链接已复制")
  }, [])

  return {
    loadingList,
    creating,
    revokingId,
    links,
    maxViews,
    usePassword,
    password,
    enableExpire,
    expireDate,
    setMaxViews,
    setUsePasswordChecked,
    setPassword,
    setEnableExpire,
    setExpireDate,
    createLink,
    revokeLink,
    copyLink,
  }
}
