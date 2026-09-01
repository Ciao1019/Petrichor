import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"

import { KeyRound } from "@/components/iconimate"
import { SiteLogo } from "@/components/site-logo"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { authApi } from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"

type SetupCheckState = "checking" | "required" | "complete" | "error"

function normalizeAxiosError(error: unknown, fallback: string): string {
  if (typeof error === "object" && error && "response" in error) {
    const response = (error as { response?: { data?: { msg?: unknown; message?: unknown } } }).response
    const message = response?.data?.msg ?? response?.data?.message
    if (typeof message === "string" && message) return message
  }
  if (error instanceof Error && error.message) return error.message
  return fallback
}

function SetupLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="size-2 rounded-full bg-primary motion-safe:animate-pulse" />
        正在检查站点状态…
      </div>
    </div>
  )
}

function SetupCheckError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>无法检查站点状态</CardTitle>
          <CardDescription>请确认 Go 服务和数据库可用，然后重新检查。</CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={onRetry}>重新检查</Button>
        </CardContent>
      </Card>
    </div>
  )
}

function SetupForm({ onInitialized }: { onInitialized: () => void }) {
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError("")

    if (Array.from(username.trim()).length < 2) {
      setError("管理员名称至少需要 2 个字符")
      return
    }
    if (Array.from(password).length < 8) {
      setError("密码长度至少为 8 位")
      return
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致")
      return
    }

    setLoading(true)
    try {
      await authApi.setup({ username: username.trim(), email: email.trim(), password })
      onInitialized()
    } catch (requestError) {
      setError(normalizeAxiosError(requestError, "初始化失败，请稍后重试"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-xl border bg-muted/50">
            <SiteLogo className="size-9 rounded-lg" size={36} />
          </div>
          <CardTitle className="text-2xl">初始化 Petrichor</CardTitle>
          <CardDescription className="max-w-sm">
            设置你的管理员名称和登录凭据，创建本站第一个超级管理员。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup>
              {error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                  {error}
                </div>
              ) : null}
              <Field>
                <FieldLabel htmlFor="setup-username">管理员名称</FieldLabel>
                <Input
                  id="setup-username"
                  autoComplete="name"
                  maxLength={50}
                  placeholder="例如：CiZai"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  disabled={loading}
                  required
                />
                <FieldDescription>用于后台展示，长度为 2 到 50 个字符。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-email">登录邮箱</FieldLabel>
                <Input
                  id="setup-email"
                  type="email"
                  autoComplete="email"
                  placeholder="owner@example.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={loading}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-password">管理员密码</FieldLabel>
                <Input
                  id="setup-password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  placeholder="至少 8 位"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={loading}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="setup-password-confirm">确认密码</FieldLabel>
                <Input
                  id="setup-password-confirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  placeholder="再次输入管理员密码"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  disabled={loading}
                  required
                />
              </Field>
              <Field>
                <Button className="w-full" type="submit" disabled={loading}>
                  <KeyRound className="mr-2 size-4" />
                  {loading ? "正在初始化…" : "创建管理员并进入后台"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
          <p className="mt-6 text-center text-xs leading-5 text-muted-foreground">
            初始化只能成功执行一次，后续访问将直接进入正常登录流程。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

export function SiteSetupGate({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const [state, setState] = useState<SetupCheckState>("checking")
  const requestVersion = useRef(0)

  const checkSetup = useCallback(() => {
    const currentRequest = ++requestVersion.current
    setState("checking")
    void authApi.setupStatus()
      .then((response) => {
        if (requestVersion.current === currentRequest) {
          setState(response.data.required ? "required" : "complete")
        }
      })
      .catch(() => {
        if (requestVersion.current === currentRequest) setState("error")
      })
  }, [])

  useEffect(() => {
    checkSetup()
    return () => {
      requestVersion.current += 1
    }
  }, [checkSetup])

  if (state === "checking") return <SetupLoading />
  if (state === "error") return <SetupCheckError onRetry={checkSetup} />
  if (state === "required") {
    return (
      <SetupForm
        onInitialized={() => {
          setState("complete")
          navigate(dashboardRoutes.root, { replace: true })
        }}
      />
    )
  }
  return children
}
