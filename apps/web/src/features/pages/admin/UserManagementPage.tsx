"use client"

import * as React from "react"
import { Loader2, Plus, RefreshCw, Search, Trash2, UserCog, X } from "lucide-react"
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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

  const handleDelete = React.useCallback((user: AdminUserItem) => {
    setDeleteTarget(user)
  }, [])

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
    <div className="flex w-full flex-col gap-6 px-6 py-6 lg:px-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <UserCog className="size-6 text-primary" />
            用户管理
          </h1>
          <p className="text-sm text-muted-foreground">
            仅超级管理员可创建和删除系统用户。用户 ID 为 1 已在后端固定为超级管理员。
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <Input
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              placeholder="按邮箱、昵称或用户名搜索"
              className="pl-9 pr-9 w-full sm:w-72"
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
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => { setPageIndex(0); setKeyword(keywordInput) }}
          >
            查询
          </Button>
          <Button
            type="button"
            onClick={() => {
              resetDialog()
              setDialogOpen(true)
            }}
          >
            <Plus className="mr-2 size-4" />
            新建用户
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>用户列表</CardTitle>
            <CardDescription>共 {total} 个用户</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void fetchData()} disabled={loading}>
            {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
            刷新
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
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
                          <div className="font-medium">{getDisplayName(user)}</div>
                          <div className="text-xs text-muted-foreground">ID: {user.id}</div>
                        </TableCell>
                        <TableCell>{user.email}</TableCell>
                        <TableCell>
                          <Badge variant={user.systemRole === "SUPER_ADMIN" ? "default" : "secondary"}>
                            {getRoleLabel(user.systemRole)}
                          </Badge>
                        </TableCell>
                        <TableCell>{user.userType || "-"}</TableCell>
                        <TableCell>{formatDateTime(user.createdAt)}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={isSelf || deletingUserId === user.id}
                            onClick={() => handleDelete(user)}
                          >
                            {deletingUserId === user.id ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : (
                              <Trash2 className="size-4 text-destructive" />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
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
        </CardContent>
      </Card>

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
