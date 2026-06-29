"use client"

import * as React from "react"
import { useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Loader2, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { FileSystem, type FileSystemFileItem, type FileSystemItem } from "@/components/extend/ui/file-system"
import { FileUpload } from "@/components/extend/ui/file-upload"
import { DocViewerPanel } from "@/features/pages/doc-library/DocViewerPanel"
import { detectFileType, parseDocument } from "@/features/pages/doc-library/lib/parse"
import {
    docLibraryApi,
    uploadApi,
    type DocDocument,
    type DocDocumentDetail,
    type DocLibrary,
} from "@/lib/api"
import { dashboardRoutes } from "@/lib/dashboard-routes"

const ACCEPT = ".pdf,.docx,.xlsx,.xls,.csv,.tsv"

function resolveApiErrorMessage(error: unknown, fallback: string) {
    const data = (error as { response?: { data?: { msg?: string } } })?.response?.data
    return data?.msg || fallback
}

export function DocLibraryBrowsePage() {
    const { libraryId } = useParams<{ libraryId: string }>()
    const navigate = useNavigate()
    const [library, setLibrary] = React.useState<DocLibrary | null>(null)
    const [documents, setDocuments] = React.useState<DocDocument[]>([])
    const [loading, setLoading] = React.useState(true)
    const [uploadOpen, setUploadOpen] = React.useState(false)
    const [uploading, setUploading] = React.useState(false)
    const [uploadProgress, setUploadProgress] = React.useState<string | null>(null)
    const [viewerDoc, setViewerDoc] = React.useState<DocDocumentDetail | null>(null)
    const [viewerOpen, setViewerOpen] = React.useState(false)
    const [viewerLoading, setViewerLoading] = React.useState(false)

    const loadDocuments = React.useCallback(async () => {
        if (!libraryId) return
        try {
            const res = await docLibraryApi.listDocuments(libraryId)
            setDocuments(res.data.documents)
        } catch (error) {
            toast.error(resolveApiErrorMessage(error, "加载文件失败"))
        }
    }, [libraryId])

    React.useEffect(() => {
        if (!libraryId) return
        let cancelled = false
        setLoading(true)
        Promise.all([docLibraryApi.listLibraries(), docLibraryApi.listDocuments(libraryId)])
            .then(([libRes, docRes]) => {
                if (cancelled) return
                setLibrary(libRes.data.libraries.find((item) => item.id === libraryId) ?? null)
                setDocuments(docRes.data.documents)
            })
            .catch((error) => {
                if (!cancelled) toast.error(resolveApiErrorMessage(error, "加载文档库失败"))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [libraryId])

    const items = React.useMemo<FileSystemItem[]>(() => {
        return documents.map((doc) => ({
            kind: "file" as const,
            path: `${doc.id}__${doc.fileName.replace(/\//g, "_")}`,
            key: doc.objectKey,
            name: doc.fileName,
            contentType: doc.contentType ?? undefined,
            size: doc.sizeBytes ?? undefined,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            metadata: { documentId: doc.id },
        }))
    }, [documents])

    const handleGetFileUrl = React.useCallback(async (file: FileSystemFileItem) => {
        const key = file.key ?? file.path
        const res = await uploadApi.presignGet(key)
        return res.data.url
    }, [])

    const openViewer = React.useCallback(async (documentId: string) => {
        setViewerOpen(true)
        setViewerLoading(true)
        setViewerDoc(null)
        try {
            const res = await docLibraryApi.documentDetail(documentId)
            setViewerDoc(res.data.document)
        } catch (error) {
            toast.error(resolveApiErrorMessage(error, "加载文件详情失败"))
            setViewerOpen(false)
        } finally {
            setViewerLoading(false)
        }
    }, [])

    const handleFileOpen = React.useCallback((file: FileSystemFileItem) => {
        const documentId = file.metadata?.documentId
        if (documentId) void openViewer(documentId)
    }, [openViewer])

    const uploadOne = React.useCallback(async (file: File) => {
        if (!libraryId) return
        const fileType = detectFileType(file)
        if (!fileType) {
            toast.error(`不支持的文件类型：${file.name}（仅支持 PDF / docx / xlsx / csv）`)
            return
        }
        setUploadProgress(`正在上传 ${file.name}…`)
        const presign = await uploadApi.presignPut({ filename: file.name })
        const putResponse = await fetch(presign.data.presignedUrl, {
            method: "PUT",
            body: file,
            headers: { "Content-Type": file.type || "application/octet-stream" },
        })
        if (!putResponse.ok) {
            throw new Error(`上传失败：HTTP ${putResponse.status}`)
        }
        setUploadProgress(`正在解析 ${file.name}…`)
        const parsed = await parseDocument(file, fileType)
        await docLibraryApi.registerDocument({
            libraryId,
            fileName: file.name,
            fileType,
            contentType: file.type || null,
            objectKey: presign.data.objectKey,
            sizeBytes: file.size,
            pageCount: parsed.pageCount,
            blocks: parsed.blocks,
            chunks: parsed.chunks,
        })
    }, [libraryId])

    const handleFilesAccepted = React.useCallback(async (files: File[]) => {
        if (files.length === 0) return
        setUploading(true)
        let success = 0
        for (const file of files) {
            try {
                await uploadOne(file)
                success += 1
            } catch (error) {
                toast.error(resolveApiErrorMessage(error, `「${file.name}」处理失败`))
            }
        }
        setUploading(false)
        setUploadProgress(null)
        if (success > 0) {
            toast.success(`已上传并解析 ${success} 个文件`)
            await loadDocuments()
            setUploadOpen(false)
        }
    }, [uploadOne, loadDocuments])

    return (
        <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                    <Button variant="ghost" size="icon" onClick={() => navigate(dashboardRoutes.docLibrary)}>
                        <ArrowLeft className="size-4" />
                    </Button>
                    <div className="min-w-0">
                        <h1 className="truncate text-lg font-semibold">{library?.name ?? "文档库"}</h1>
                        <p className="text-xs text-muted-foreground">{documents.length} 个文件</p>
                    </div>
                </div>
                <Button onClick={() => setUploadOpen(true)}>
                    <Upload className="size-4" />
                    上传文件
                </Button>
            </div>

            <div className="min-h-0 flex-1 p-4">
                {loading ? (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                        <Loader2 className="size-5 animate-spin" />
                    </div>
                ) : (
                    <FileSystem
                        className="h-full"
                        title={library?.name ?? "文档库"}
                        items={items}
                        defaultView="icons"
                        getFileUrl={handleGetFileUrl}
                        onFileOpen={handleFileOpen}
                    />
                )}
            </div>

            <Dialog open={uploadOpen} onOpenChange={(open) => !uploading && setUploadOpen(open)}>
                <DialogContent className="sm:max-w-xl">
                    <DialogHeader>
                        <DialogTitle>上传文件</DialogTitle>
                        <DialogDescription>
                            仅支持双层 PDF（带文本层）、docx、xlsx、csv。上传后会在浏览器中解析文本以支持问答。
                        </DialogDescription>
                    </DialogHeader>
                    {uploading ? (
                        <div className="flex flex-col items-center justify-center gap-3 py-10 text-sm text-muted-foreground">
                            <Loader2 className="size-6 animate-spin" />
                            {uploadProgress ?? "处理中…"}
                        </div>
                    ) : (
                        <FileUpload
                            accept={ACCEPT}
                            multiple
                            showFileList={false}
                            title="拖拽文件到此处，或点击选择"
                            description="支持 PDF / Word / Excel / CSV"
                            onFilesAccepted={handleFilesAccepted}
                        />
                    )}
                </DialogContent>
            </Dialog>

            <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
                <DialogContent
                    className="flex h-[88vh] w-[96vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1400px]"
                    showCloseButton
                >
                    <DialogHeader className="border-b border-border/60 px-4 py-3">
                        <DialogTitle className="truncate text-sm">{viewerDoc?.fileName ?? "文件预览"}</DialogTitle>
                    </DialogHeader>
                    <div className="min-h-0 flex-1">
                        {viewerLoading ? (
                            <div className="flex h-full items-center justify-center text-muted-foreground">
                                <Loader2 className="size-5 animate-spin" />
                            </div>
                        ) : (
                            <DocViewerPanel document={viewerDoc} />
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
