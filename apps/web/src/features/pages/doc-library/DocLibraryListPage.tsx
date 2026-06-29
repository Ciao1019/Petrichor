"use client"

import * as React from "react"
import { useNavigate } from "react-router-dom"
import { FileText, FolderPlus, Loader2, MoreHorizontal, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
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
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { docLibraryApi, type DocLibrary } from "@/lib/api"
import { docLibraryBrowsePath } from "@/lib/dashboard-routes"
import { cn } from "@/lib/utils"

const CARD_COLORS = [
    "from-sky-500/90 to-sky-700/90",
    "from-violet-500/90 to-violet-700/90",
    "from-rose-500/90 to-rose-700/90",
    "from-emerald-500/90 to-emerald-700/90",
    "from-amber-500/90 to-amber-700/90",
    "from-cyan-500/90 to-cyan-700/90",
]

function resolveApiErrorMessage(error: unknown, fallback: string) {
    const data = (error as { response?: { data?: { msg?: string } } })?.response?.data
    return data?.msg || fallback
}

export function DocLibraryListPage() {
    const navigate = useNavigate()
    const [libraries, setLibraries] = React.useState<DocLibrary[]>([])
    const [loading, setLoading] = React.useState(true)
    const [dialogOpen, setDialogOpen] = React.useState(false)
    const [mode, setMode] = React.useState<"create" | "edit">("create")
    const [active, setActive] = React.useState<DocLibrary | null>(null)
    const [name, setName] = React.useState("")
    const [description, setDescription] = React.useState("")
    const [saving, setSaving] = React.useState(false)
    const [pendingDelete, setPendingDelete] = React.useState<DocLibrary | null>(null)
    const [deleting, setDeleting] = React.useState(false)

    const load = React.useCallback(async () => {
        setLoading(true)
        try {
            const res = await docLibraryApi.listLibraries()
            setLibraries(res.data.libraries)
        } catch (error) {
            toast.error(resolveApiErrorMessage(error, "加载文档库失败"))
        } finally {
            setLoading(false)
        }
    }, [])

    React.useEffect(() => {
        void load()
    }, [load])

    const openCreate = () => {
        setMode("create")
        setActive(null)
        setName("")
        setDescription("")
        setDialogOpen(true)
    }

    const openEdit = (library: DocLibrary) => {
        setMode("edit")
        setActive(library)
        setName(library.name)
        setDescription(library.description ?? "")
        setDialogOpen(true)
    }

    const handleSave = async () => {
        if (!name.trim()) {
            toast.error("文档库名称不能为空")
            return
        }
        setSaving(true)
        try {
            await docLibraryApi.saveLibrary({
                id: mode === "edit" ? active?.id : null,
                name: name.trim(),
                description: description.trim() || null,
            })
            toast.success(mode === "edit" ? "已更新文档库" : "已创建文档库")
            setDialogOpen(false)
            await load()
        } catch (error) {
            toast.error(resolveApiErrorMessage(error, "保存失败"))
        } finally {
            setSaving(false)
        }
    }

    const handleDelete = async () => {
        if (!pendingDelete) return
        setDeleting(true)
        try {
            await docLibraryApi.deleteLibrary(pendingDelete.id)
            toast.success("已删除文档库")
            setPendingDelete(null)
            await load()
        } catch (error) {
            toast.error(resolveApiErrorMessage(error, "删除失败"))
        } finally {
            setDeleting(false)
        }
    }

    return (
        <div className="mx-auto w-full max-w-7xl px-6 py-8">
            <div className="mb-8 flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">文档库</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                        存放原始文件（PDF / Word / Excel / CSV），并对文件内容进行问答。
                    </p>
                </div>
                <Button onClick={openCreate}>
                    <Plus className="size-4" />
                    新建文档库
                </Button>
            </div>

            {loading ? (
                <div className="flex h-64 items-center justify-center text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                </div>
            ) : libraries.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-muted-foreground">
                    <FolderPlus className="size-10 opacity-50" />
                    <p>还没有文档库，点击右上角新建一个吧</p>
                </div>
            ) : (
                <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {libraries.map((library, index) => (
                        <div
                            key={library.id}
                            role="button"
                            tabIndex={0}
                            onClick={() => navigate(docLibraryBrowsePath(library.id))}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") navigate(docLibraryBrowsePath(library.id))
                            }}
                            className={cn(
                                "group relative flex aspect-[3/4] cursor-pointer flex-col justify-between overflow-hidden rounded-2xl bg-gradient-to-br p-5 text-white shadow-md transition-transform hover:-translate-y-1 hover:shadow-xl",
                                CARD_COLORS[index % CARD_COLORS.length],
                            )}
                        >
                            <div className="flex items-start justify-between">
                                <FileText className="size-7 opacity-90" />
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                        <button
                                            type="button"
                                            className="rounded-md p-1 text-white/80 opacity-0 transition-opacity hover:bg-white/15 hover:text-white group-hover:opacity-100"
                                        >
                                            <MoreHorizontal className="size-5" />
                                        </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                                        <DropdownMenuItem onSelect={() => openEdit(library)}>编辑</DropdownMenuItem>
                                        <DropdownMenuItem
                                            variant="destructive"
                                            onSelect={() => setPendingDelete(library)}
                                        >
                                            <Trash2 className="size-4" />
                                            删除
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                            <div>
                                <h3 className="line-clamp-2 text-xl font-bold">{library.name}</h3>
                                <p className="mt-1 line-clamp-2 text-sm text-white/80">
                                    {library.description || "暂无描述"}
                                </p>
                                <div className="mt-4 flex items-center justify-between text-xs text-white/70">
                                    <span>{library.documentCount} 个文件</span>
                                    <span>更新于 {new Date(library.updatedAt).toLocaleDateString()}</span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            <Dialog open={dialogOpen} onOpenChange={(open) => !saving && setDialogOpen(open)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{mode === "edit" ? "编辑文档库" : "新建文档库"}</DialogTitle>
                        <DialogDescription>文档库用于存放文件并对其内容进行问答。</DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                        <div className="space-y-2">
                            <Label htmlFor="doc-lib-name">名称</Label>
                            <Input
                                id="doc-lib-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="例如：合同库 / 论文库"
                                maxLength={80}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="doc-lib-desc">描述（可选）</Label>
                            <Textarea
                                id="doc-lib-desc"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder="一句话说明这个文档库存放什么"
                                rows={3}
                                maxLength={500}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                            取消
                        </Button>
                        <Button onClick={handleSave} disabled={saving}>
                            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                            保存
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <AlertDialog open={pendingDelete != null} onOpenChange={(open) => !deleting && !open && setPendingDelete(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>删除文档库「{pendingDelete?.name}」？</AlertDialogTitle>
                        <AlertDialogDescription>
                            此操作无法撤销，库内所有文件、文本片段与相关问答数据将被永久删除。
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={deleting}
                            onClick={(e) => {
                                e.preventDefault()
                                void handleDelete()
                            }}
                        >
                            {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
                            删除
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    )
}
