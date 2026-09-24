"use client"

import * as React from "react"
import { Loader2, Plus, RefreshCw, Search, Trash2, X } from "@/components/iconimate"
import { toast } from "sonner"

import { PasswordFields } from "@/components/account/PasswordFields"
import { validatePasswordStrength } from "@/components/account/password-utils"
import { AppPagination } from "@/components/app-pagination"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  adminUserApi,
  authApi,
  type AdminUserItem,
  type SystemRole,
  type UserResponse,
} from "@/lib/api"

function getDisplayName(user: Pick<AdminUserItem, "nickname" | "username" | "email">) {
  return user.nickname || user.username || user.email
}

function getRoleLabel(role: SystemRole) {
  return role === "SUPER_ADMIN" ? "超级管理员" : "普通用户"
}

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

export function UserManagementPage() {
  const [rows, setRows] = React.useState<AdminUserItem[]>([])
  const [total, setTotal] = React.useState(0)
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageSize] = React.useState(10)
  const [keywordInput, setKeywordInput] = React.useState("")
  const [keyword, setKeyword] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [deletingUserId, setDeletingUserId] = React.useState<string | null>(null)
  const [currentUser, setCurrentUser] = React.useState<UserResponse | null>(null)
  const [deleteTarget, setDeleteTarget] = React.useState<AdminUserItem | null>(null)

  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [name, setName] = React.useState("")
  const [systemRole, setSystemRole] = React.useState<SystemRole>("USER")

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const fetchData = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminUserApi.list({
        pageNum: pageIndex + 1,
        pageSize,
        keyword: keyword.trim() || undefined,
      })
      setRows(res.data.rows || [])
      setTotal(res.data.total || 0)
    } catch (e) {
      toast.error(
        typeof e === "object" &&
          e &&
          "response" in e &&
          typeof (e as { response?: { data?: { msg?: unknown } } }).response?.data?.msg === "string"
          ? String((e as { response?: { data?: { msg?: unknown } } }).response?.data?.msg)
          : "加载用户列表失败",
      )
    } finally {
      setLoading(false)
    }
  }, [keyword, pageIndex, pageSize])

  React.useEffect(() => {
    authApi.me().then((res) => setCurrentUser(res.data)).catch(() => {})
  }, [])

  React.useEffect(() => {
    void fetchData()
  }, [fetchData])

  React.useEffect(() => {
    if (pageIndex > totalPages - 1) {
      setPageIndex(Math.max(0, totalPages - 1))
    }
  }, [pageIndex, totalPages])

  const resetDialog = React.useCallback(() => {
    setEmail("")
    setPassword("")
    setConfirmPassword("")
    setName("")
    setSystemRole("USER")
  }, [])

  const handleDialogOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      resetDialog()
    }
    setDialogOpen(nextOpen)
  }, [resetDialog])

  const submitCreate = React.useCallback(async () => {
    const normalizedEmail = email.trim()
    const normalizedName = name.trim()
    if (!normalizedEmail) {
      toast.error("请输入邮箱")
      return
    }
    if (!password.trim()) {
      toast.error("请输入密码")
      return
    }
    const passwordError = validatePasswordStrength(password.trim())
    if (passwordError) {
      toast.error(passwordError)
      return
    }
    if (password.trim() !== confirmPassword.trim()) {
      toast.error("两次输入的密码不一致")
      return
    }
    if (!normalizedName) {
      toast.error("请输入用户名称")
      return
    }
    setSaving(true)
    try {
      await adminUserApi.create({
        email: normalizedEmail,
        password,
        name: normalizedName,
        systemRole,
      })
      toast.success("用户已创建")
      setDialogOpen(false)
      resetDialog()
      setPageIndex(0)
      setKeyword("")
      setKeywordInput("")
      await fetchData()
    } catch (e) {
      toast.error(
        typeof e === "object" &&
          e &&
          "response" in e &&
          typeof (e as { response?: { data?: { msg?: unknown } } }).response?.data?.msg === "string"
          ? String((e as { response?: { data?: { msg?: unknown } } }).response?.data?.msg)
          : "创建用户失败",
      )
    } finally {
      setSaving(false)
    }
  }, [confirmPassword, email, fetchData, name, password, resetDialog, systemRole])

  const confirmDelete = React.useCallback(async () => {
    if (!deleteTarget) return
    setDeletingUserId(deleteTarget.id)
    try {
      await adminUserApi.delete({ userId: deleteTarget.id })
      toast.success("用户已删除")
      setDeleteTarget(null)
      await fetchData()
    } catch (e) {
      toast.error(
        typeof e === "object" &&
          e &&
          "response" in e &&
          typeof (e as { response?: { data?: { msg?: unknown } } }).response?.data?.msg === "string"
          ? String((e as { response?: { data?: { msg?: unknown } } }).response?.data?.msg)
          : "删除用户失败",
      )
    } finally {
      setDeletingUserId(null)
    }
  }, [deleteTarget, fetchData])

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 md:py-8 md:px-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-6 border-b border-border/50">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            用户管理
          </h1>
          <p className="text-sm text-muted-foreground">
            管理系统用户与权限角色，用户 ID 为 1 固定为超级管理员。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              placeholder="按邮箱、昵称或用户名搜索"
              className="pl-8.5 pr-8 w-full sm:w-64 h-9 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setPageIndex(0)
                  setKeyword(keywordInput)
                }
              }}
            />
            {keywordInput ? (
              <button
                type="button"
                onClick={() => { setKeywordInput(""); setKeyword(""); setPageIndex(0) }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              resetDialog()
              setDialogOpen(true)
            }}
          >
            <Plus className="mr-1.5 size-3.5" />
            新建用户
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void fetchData()} disabled={loading}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>共 {total} 个系统用户</span>
        </div>

        <div className="rounded-lg border border-border/40 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="w-[240px]">用户</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead className="w-[120px]">系统角色</TableHead>
                <TableHead className="w-[120px]">登录类型</TableHead>
                <TableHead className="w-[180px]">创建时间</TableHead>
                <TableHead className="w-[100px] text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <TableRow key={`user-skeleton-${index}`} className="animate-pulse">
                    <TableCell><div className="h-4 w-28 rounded bg-muted" /></TableCell>
                    <TableCell><div className="h-4 w-40 rounded bg-muted" /></TableCell>
                    <TableCell><div className="h-4 w-20 rounded bg-muted" /></TableCell>
                    <TableCell><div className="h-4 w-16 rounded bg-muted" /></TableCell>
                    <TableCell><div className="h-4 w-28 rounded bg-muted" /></TableCell>
                    <TableCell><div className="ml-auto h-8 w-8 rounded bg-muted" /></TableCell>
                  </TableRow>
                ))
              ) : rows.length > 0 ? (
                rows.map((user) => {
                  const isSelf = currentUser?.id === user.id
                  return (
                    <TableRow key={user.id}>
                      <TableCell className="space-y-1">
                        <div className="font-medium text-sm">{getDisplayName(user)}</div>
                        <div className="text-xs text-muted-foreground">ID: {user.id}</div>
                      </TableCell>
                      <TableCell className="text-sm">{user.email}</TableCell>
                      <TableCell>
                        <Badge variant={user.systemRole === "SUPER_ADMIN" ? "default" : "secondary"}>
                          {getRoleLabel(user.systemRole)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">{user.userType || "-"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatDateTime(user.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          disabled={isSelf || user.id === "1" || deletingUserId === user.id}
                          title={isSelf ? "不可删除当前登录账号" : user.id === "1" ? "不可删除初始超级管理员" : "删除用户"}
                          onClick={() => setDeleteTarget(user)}
                        >
                          {deletingUserId === user.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Trash2 className="size-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground text-sm">
                    暂无用户数据
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <AppPagination
          page={pageIndex}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          disabled={loading}
          onChange={(nextPageIndex) => setPageIndex(nextPageIndex)}
        />
      </div>

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>
              创建后即可使用邮箱密码登录系统。请按实际职责分配系统角色和知识库权限。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="admin-user-email">邮箱</Label>
              <Input
                id="admin-user-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="请输入邮箱"
              />
            </div>
            <div className="space-y-2">
              <PasswordFields
                password={password}
                confirmPassword={confirmPassword}
                onPasswordChange={setPassword}
                onConfirmPasswordChange={setConfirmPassword}
                passwordId="admin-user-password"
                confirmPasswordId="admin-user-confirm-password"
                passwordName="admin-user-new-password"
                confirmPasswordName="admin-user-confirm-new-password"
                passwordAutoComplete="new-password"
                confirmPasswordAutoComplete="new-password"
                passwordLabel="登录密码"
                confirmPasswordLabel="确认登录密码"
                passwordPlaceholder="至少 8 位，含大写字母、数字、特殊字符"
                confirmPasswordPlaceholder="请再次输入登录密码"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="admin-user-name">名称</Label>
              <Input
                id="admin-user-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="昵称或姓名"
              />
            </div>
            <div className="space-y-2">
              <Label>系统角色</Label>
              <Select value={systemRole} onValueChange={(value) => setSystemRole(value as SystemRole)}>
                <SelectTrigger>
                  <SelectValue placeholder="请选择系统角色" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">普通用户</SelectItem>
                  <SelectItem value="SUPER_ADMIN">超级管理员</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void submitCreate()} disabled={saving}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              创建用户
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除用户？</AlertDialogTitle>
            <AlertDialogDescription>
              将永久删除用户「{deleteTarget ? getDisplayName(deleteTarget) : ""}」，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(deletingUserId)}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={Boolean(deletingUserId)}
              onClick={() => void confirmDelete()}
            >
              {deletingUserId ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
