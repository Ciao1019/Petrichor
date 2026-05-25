import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { authApi } from '@/lib/api'
import { dashboardRoutes } from '@/lib/dashboard-routes'

export function AuthCallback() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const isBinding = state?.startsWith('bind:')
  const [error, setError] = useState<string | null>(null)
  const viewError = error || (!code ? '授权失败：未获取到授权码' : null)

  useEffect(() => {
    if (!code) {
      return
    }

    authApi.linuxDoCallback(code, state)
      .then((res) => {
        navigate(res.data.mode === 'bind' ? `${dashboardRoutes.account}?linuxdoBinding=success` : dashboardRoutes.root)
      })
      .catch(() => {
        setError(isBinding ? '绑定失败，请重试' : '登录失败，请重试')
      })
  }, [code, isBinding, navigate, state])

  if (viewError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-destructive">{viewError}</p>
          <a href="/login" className="text-primary underline mt-4 block">返回登录</a>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center">
        <p className="text-muted-foreground">{isBinding ? '正在绑定...' : '正在登录...'}</p>
      </div>
    </div>
  )
}
