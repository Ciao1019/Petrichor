export const PASSWORD_CHECKS = [
  { label: "至少 8 个字符", test: (v: string) => v.length >= 8 },
  { label: "包含大写字母", test: (v: string) => /[A-Z]/.test(v) },
  { label: "包含数字", test: (v: string) => /\d/.test(v) },
  { label: "包含特殊字符", test: (v: string) => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(v) },
]

export function validatePasswordStrength(value: string): string | null {
  if (value.length < 8) return "密码至少需要 8 个字符"
  if (!/[A-Z]/.test(value)) return "密码必须包含大写字母"
  if (!/\d/.test(value)) return "密码必须包含数字"
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(value)) return "密码必须包含特殊字符"
  return null
}

export function generatePassword(): string {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  const lower = "abcdefghijklmnopqrstuvwxyz"
  const digits = "0123456789"
  const special = "!@#$%^&*"
  const all = upper + lower + digits + special
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)]
  const chars = [pick(upper), pick(digits), pick(special), pick(lower)]
  for (let i = 4; i < 16; i++) chars.push(pick(all))
  return chars.sort(() => Math.random() - 0.5).join("")
}

export function getPasswordPassedCount(value: string) {
  return PASSWORD_CHECKS.filter((check) => check.test(value)).length
}
