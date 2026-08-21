import { FileCode, FileDigit, FileIcon as FileIconLucide, FileText, ImageIcon } from "@/components/iconimate"
import { cn } from "@/lib/utils"

export type FileType = "folder" | "file"

interface FileIconProps {
  name: string
  isDirectory?: boolean
  className?: string
}

export function FileIcon({ name, isDirectory, className }: FileIconProps) {
  if (isDirectory) {
    return null // Folders handled by TreeIcon's default logic or passed explicitly if needed, but here we strictly handle file icons
  }

  const ext = name.split(".").pop()?.toLowerCase() || ""

  switch (ext) {
    case "pdf":
      return <FileDigit className={cn("h-4 w-4 text-red-500", className)} />
    case "doc":
    case "docx":
      return <FileText className={cn("h-4 w-4 text-blue-500", className)} />
    case "txt":
      return <FileText className={cn("h-4 w-4 text-zinc-500", className)} />
    case "md":
      return <FileCode className={cn("h-4 w-4 text-emerald-500", className)} />
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "svg":
    case "avif":
      return <ImageIcon className={cn("h-4 w-4 text-purple-500", className)} />
    default:
      return <FileIconLucide className={cn("h-4 w-4 text-gray-400", className)} />
  }
}
