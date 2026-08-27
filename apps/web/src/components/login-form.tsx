import { useState } from "react"
import { LogIn } from "@/components/iconimate"
import { Link } from "react-router-dom"

import { SiteLogo } from "@/components/site-logo"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { authApi } from "@/lib/api"
import { cn } from "@/lib/utils"

interface LoginFormProps extends React.ComponentProps<"div"> {
  onLoginSuccess?: (token?: string) => void
}

const registerEnabled = import.meta.env.PETRICHOR_PUBLIC_REGISTER_ENABLED === "true"

function normalizeAxiosError(e: unknown, fallback: string): string {
  if (typeof e === "object" && e && "response" in e) {
    const response = (e as { response?: { data?: { msg?: unknown; message?: unknown } } }).response
    const msg = response?.data?.msg ?? response?.data?.message
    if (typeof msg === "string" && msg) {
      return msg
    }
  }
  if (e instanceof Error && e.message) {
    return e.message
  }
  return fallback
}

export function LoginForm({
  className,
  onLoginSuccess,
  ...props
}: LoginFormProps) {
  const [mode, setMode] = useState<"login" | "register">("login")
  const currentMode = registerEnabled ? mode : "login"
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [loading, setLoading] = useState(false)
  const [linuxDoLoading, setLinuxDoLoading] = useState(false)
  const [error, setError] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError("")

    try {
      if (currentMode === "login") {
        const response = await authApi.login({ email, password })
        onLoginSuccess?.(response.data.token)
      } else {
        const response = await authApi.register({ email, password, name })
        const { token } = response.data
        onLoginSuccess?.(token)
      }
    } catch (err) {
      setError(normalizeAxiosError(
        err,
        currentMode === "login" ? "登录失败，请检查邮箱和密码" : "注册失败，请检查输入信息",
      ))
    } finally {
      setLoading(false)
    }
  }

  const switchMode = () => {
    setMode(mode === "login" ? "register" : "login")
    setError("")
    setEmail("")
    setPassword("")
    setName("")
  }

  const startLinuxDoLogin = () => {
    setLinuxDoLoading(true)
    setError("")
    window.location.assign("/api/auth/linuxdo/login/start")
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <Link
              to="/"
              className="flex flex-col items-center gap-2 font-medium"
            >
              <div className="flex size-8 items-center justify-center rounded-md">
                <SiteLogo className="size-8 rounded-md" size={32} />
              </div>
              <span className="sr-only">返回首页 · Petrichor</span>
            </Link>
            <h1 className="text-xl font-bold">
              {currentMode === "login" ? "欢迎登录" : "创建账号"}
            </h1>
            {registerEnabled && (
              <FieldDescription>
                {currentMode === "login" ? (
                  <>还没有账号？ <button type="button" className="underline cursor-pointer" onClick={switchMode}>注册</button></>
                ) : (
                  <>已有账号？ <button type="button" className="underline cursor-pointer" onClick={switchMode}>登录</button></>
                )}
              </FieldDescription>
            )}
          </div>
          {error && (
            <div className="text-sm text-destructive text-center">{error}</div>
          )}
          {currentMode === "register" && (
            <Field>
              <FieldLabel htmlFor="name">用户名</FieldLabel>
              <Input
                id="name"
                type="text"
                placeholder="请输入用户名"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="email">邮箱</FieldLabel>
            <Input
              id="email"
              type="email"
              placeholder="m@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">密码</FieldLabel>
            <Input
              id="password"
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <Field>
            <Button type="submit" disabled={loading || linuxDoLoading}>
              {loading
                ? (currentMode === "login" ? "登录中..." : "注册中...")
                : (currentMode === "login" ? "登录" : "注册")}
            </Button>
          </Field>
          {currentMode === "login" ? (
            <Field>
              <Button
                type="button"
                variant="outline"
                disabled={loading || linuxDoLoading}
                onClick={startLinuxDoLogin}
              >
                <LogIn className="h-4 w-4 mr-2" />
                {linuxDoLoading ? "跳转中..." : "使用 Linux.do 登录"}
              </Button>
            </Field>
          ) : null}
        </FieldGroup>
      </form>
      <FieldDescription className="px-6 text-center">
        点击继续即表示您同意我们的<span className="text-foreground font-medium">服务条款</span>和
        <span className="text-foreground font-medium">隐私政策</span>。
      </FieldDescription>
    </div>
  )
}
