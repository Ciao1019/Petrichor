import * as React from "react"

import { publicArticleShareApi, type PublicSharedArticleDetailResponse } from "@/lib/api"

function usePublicArticleDetailRequest(
  shareCode: string | undefined,
  submittedPassword: string | null,
  onNeedPassword: (need: boolean) => void
) {
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [data, setData] = React.useState<PublicSharedArticleDetailResponse | null>(null)

  React.useEffect(() => {
    if (!shareCode) {
      setError("缺少分享码")
      setData(null)
      return
    }

    let canceled = false
    setData(null)
    setLoading(true)
    setError(null)

    publicArticleShareApi
      .detail(shareCode, submittedPassword, { forceRefresh: !submittedPassword })
      .then((res) => {
        if (canceled) return
        setData(res.data)
        onNeedPassword(false)
        setError(null)
      })
      .catch((e: unknown) => {
        if (canceled) return
        const status: number | undefined = (e as { response?: { status?: number } })?.response?.status
        const msg: string =
          (e as { response?: { data?: { msg?: string } } })?.response?.data?.msg ||
          (e instanceof Error ? e.message : "") ||
          "加载失败"
        onNeedPassword(status === 401 || msg.includes("密码"))
        setError(msg)
        setData(null)
      })
      .finally(() => {
        if (canceled) return
        setLoading(false)
      })

    return () => {
      canceled = true
    }
  }, [shareCode, submittedPassword, onNeedPassword])

  return { loading, error, data }
}

export function usePublicArticleShareDetail(shareCode: string | undefined) {
  const [needPassword, setNeedPassword] = React.useState(false)
  const [accessPassword, setAccessPassword] = React.useState("")
  const [submittedPassword, setSubmittedPassword] = React.useState<string | null>(null)

  React.useEffect(() => {
    setAccessPassword("")
    setSubmittedPassword(null)
    setNeedPassword(false)
  }, [shareCode])

  const { loading, error, data } = usePublicArticleDetailRequest(shareCode, submittedPassword, setNeedPassword)
  const submitPassword = React.useCallback(() => setSubmittedPassword(accessPassword), [accessPassword])

  return { loading, error, data, needPassword, accessPassword, setAccessPassword, submitPassword }
}
