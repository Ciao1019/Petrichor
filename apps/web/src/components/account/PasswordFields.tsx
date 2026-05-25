"use client"

import * as React from "react"
import { Eye, EyeOff, Shuffle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  generatePassword,
  getPasswordPassedCount,
  PASSWORD_CHECKS,
} from "@/components/account/password-utils"

type PasswordFieldsProps = {
  password: string
  confirmPassword: string
  onPasswordChange: (value: string) => void
  onConfirmPasswordChange: (value: string) => void
  passwordId?: string
  confirmPasswordId?: string
  passwordName?: string
  confirmPasswordName?: string
  passwordAutoComplete?: string
  confirmPasswordAutoComplete?: string
  passwordLabel?: string
  confirmPasswordLabel?: string
  passwordPlaceholder?: string
  confirmPasswordPlaceholder?: string
}

export function PasswordFields({
  password,
  confirmPassword,
  onPasswordChange,
  onConfirmPasswordChange,
  passwordId = "password-fields-password",
  confirmPasswordId = "password-fields-confirm",
  passwordName = "new-password",
  confirmPasswordName = "confirm-new-password",
  passwordAutoComplete = "new-password",
  confirmPasswordAutoComplete = "new-password",
  passwordLabel = "新密码",
  confirmPasswordLabel = "确认密码",
  passwordPlaceholder = "至少 8 位，含大写字母、数字、特殊字符",
  confirmPasswordPlaceholder = "请再次输入密码",
}: PasswordFieldsProps) {
  const [passwordVisible, setPasswordVisible] = React.useState(false)
  const passedCount = React.useMemo(() => getPasswordPassedCount(password), [password])

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={passwordId}>{passwordLabel}</Label>
        <div className="flex gap-2">
          <Input
            id={passwordId}
            name={passwordName}
            type={passwordVisible ? "text" : "password"}
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            autoComplete={passwordAutoComplete}
            placeholder={passwordPlaceholder}
            className="flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setPasswordVisible((value) => !value)}
            title={passwordVisible ? "隐藏密码" : "显示密码"}
          >
            {passwordVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => onPasswordChange(generatePassword())}
            title="随机生成密码"
          >
            <Shuffle className="h-4 w-4" />
          </Button>
        </div>
        {password ? (
          <div className="space-y-2 pt-1">
            <div className="flex gap-1">
              {Array.from({ length: 4 }, (_, index) => {
                const colors = ["bg-red-500", "bg-yellow-500", "bg-blue-500", "bg-green-500"]
                return (
                  <div
                    key={index}
                    className={`h-1 flex-1 rounded-full transition-colors duration-300 ${index < passedCount ? colors[passedCount - 1] : "bg-muted"}`}
                  />
                )
              })}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {PASSWORD_CHECKS.map((check) => {
                const passed = check.test(password)
                return (
                  <div
                    key={check.label}
                    className={`flex items-center gap-1.5 text-xs transition-colors ${passed ? "text-green-500" : "text-muted-foreground"}`}
                  >
                    <svg
                      width={10}
                      height={10}
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      {passed ? <path d="M3 8.5l3.5 3.5L13 5" /> : <circle cx="8" cy="8" r="5" />}
                    </svg>
                    {check.label}
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={confirmPasswordId}>{confirmPasswordLabel}</Label>
        <Input
          id={confirmPasswordId}
          name={confirmPasswordName}
          type="password"
          value={confirmPassword}
          onChange={(e) => onConfirmPasswordChange(e.target.value)}
          autoComplete={confirmPasswordAutoComplete}
          placeholder={confirmPasswordPlaceholder}
        />
      </div>
    </>
  )
}
