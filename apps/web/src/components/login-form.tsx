import { useState } from "react"
import { LogIn } from "lucide-react"

import { SiteLogo } from "@/components/site-logo"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { authApi, twoFactorApi } from "@/lib/api"
import { cn } from "@/lib/utils"

interface LoginFormProps extends React.ComponentProps<"div"> {
  onLoginSuccess?: (token?: string) => void
}

const registerEnabled = process.env.NEXT_PUBLIC_REGISTER_ENABLED === "true"

type LoginStage = "credentials" | "totp" | "backup"

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
  const [stage, setStage] = useState<LoginStage>("credentials")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [twoFactorCode, setTwoFactorCode] = useState("")
  const [loading, setLoading] = useState(false)
  const [linuxDoLoading, setLinuxDoLoading] = useState(false)
  const [error, setError] = useState("")

  const resetTwoFactor = () => {
    setTwoFactorCode("")
    setStage("credentials")
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError("")

    try {
      if (currentMode === "login") {
        const response = await authApi.login({ email, password })
        if (response.data.twoFactorRequired) {
          setStage("totp")
          return
        }
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

  const handleVerifyTwoFactor = async (e: React.FormEvent) => {
    e.preventDefault()
    const code = twoFactorCode.trim()
    if (!code) {
      setError(stage === "backup" ? "请输入备份码" : "请输入 6 位验证码")
      return
    }
    setLoading(true)
    setError("")
    try {
      if (stage === "backup") {
        const response = await twoFactorApi.verifyBackupCode({ code })
        onLoginSuccess?.(response.data.token)
      } else {
        const response = await twoFactorApi.verifyTotp({ code })
        onLoginSuccess?.(response.data.token)
      }
    } catch (err) {
      setError(normalizeAxiosError(err, "验证码错误，请重试"))
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
    resetTwoFactor()
  }

  const startLinuxDoLogin = () => {
    setLinuxDoLoading(true)
    setError("")
    window.location.assign("/api/auth/linuxdo/login/start")
  }

  if (stage !== "credentials") {
    const isBackup = stage === "backup"
    return (
      <div className={cn("flex flex-col gap-6", className)} {...props}>
        <form onSubmit={handleVerifyTwoFactor}>
          <FieldGroup>
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex size-8 items-center justify-center rounded-md">
                <SiteLogo className="size-8 rounded-md" size={32} />
              </div>
              <h1 className="text-xl font-bold">二步验证</h1>
              <FieldDescription>
                {isBackup
                  ? "输入剩余的某个一次性备份码完成登录。"
                  : "请打开 Authenticator 应用，输入当前显示的 6 位验证码。"}
              </FieldDescription>
            </div>
            {error && (
              <div className="text-sm text-destructive text-center">{error}</div>
            )}
            <Field>
              <FieldLabel htmlFor="twoFactorCode">{isBackup ? "备份码" : "6 位验证码"}</FieldLabel>
              <Input
                id="twoFactorCode"
                type="text"
                inputMode={isBackup ? "text" : "numeric"}
                autoComplete="one-time-code"
                placeholder={isBackup ? "例如 a1b2c3d4e5" : "123456"}
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value)}
                required
              />
            </Field>
            <Field>
              <Button type="submit" variant="outline" disabled={loading}>
                {loading ? "验证中..." : "验证并登录"}
              </Button>
            </Field>
            <Field>
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => {
                  setError("")
                  setTwoFactorCode("")
                  setStage(isBackup ? "totp" : "backup")
                }}
              >
                {isBackup ? "改用 Authenticator 验证码" : "使用备份码登录"}
              </Button>
            </Field>
            <Field>
              <Button
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={resetTwoFactor}
              >
                返回上一步
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form onSubmit={handleSubmit}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <a
              href="#"
              className="flex flex-col items-center gap-2 font-medium"
            >
              <div className="flex size-8 items-center justify-center rounded-md">
                <SiteLogo className="size-8 rounded-md" size={32} />
              </div>
              <span className="sr-only">Petrichor</span>
            </a>
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
            <Button type="submit" variant="outline" disabled={loading || linuxDoLoading}>
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
        点击继续即表示您同意我们的 <a href="#">服务条款</a> 和{" "}
        <a href="#">隐私政策</a>。
      </FieldDescription>
    </div>
  )
}
