import * as React from "react"
import { Button } from "@/components/ui/button"
import { uploadApi, type DocumentImportPageResponse, type DocumentImportImagePolicy } from "@/lib/api"

function SavedImage({ imageKey, label }: { imageKey: string; label: string }) {
  const [url, setUrl] = React.useState<string>()
  const [error, setError] = React.useState(false)
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    let active = true
    uploadApi.presignGet(imageKey).then(({ data }) => {
      if (active) setUrl(data.url)
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [imageKey, attempt])
  if (error) return <div className="text-xs text-muted-foreground">图片预览加载失败<Button size="sm" variant="ghost" onClick={() => { setError(false); setUrl(undefined); setAttempt(attempt + 1) }}>重新加载</Button></div>
  if (!url) return <p className="text-xs text-muted-foreground" role="status">正在加载图片…</p>
  return <a href={url} target="_blank" rel="noopener noreferrer" className="block rounded focus-visible:outline-2 focus-visible:outline-ring"><img src={url} alt={label} loading="lazy" onError={() => setError(true)} className="max-h-96 max-w-full rounded border object-contain" /></a>
}

export function DocumentImportAssets({ page, imagePolicy }: { page: DocumentImportPageResponse; imagePolicy?: DocumentImportImagePolicy }) {
  const [open, setOpen] = React.useState(false)
  const [previewOpen, setPreviewOpen] = React.useState(false)
  const assets = page.assets ?? []
  if (!assets.length) return null
  const failed = assets.filter((asset) => asset.status === "failed").length
  const textOnly = imagePolicy === "text_only"
  return (
    <details className="min-w-0 rounded border bg-muted/20 px-3 py-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs focus-visible:outline-2 focus-visible:outline-ring">
        {textOnly ? `图片文字识别 · ${assets.length} 个区域` : `已保留 ${assets.length} 张图片`}{failed > 0 ? ` · ${failed} 张识别失败${textOnly ? "，可重试" : "，原图仍可查看"}` : ""}
      </summary>
      {open ? <div className="mt-3 space-y-4">
        {assets.map((asset, index) => (
          <div key={asset.id} className="min-w-0 space-y-2">
            <p className="break-words text-xs text-muted-foreground">
              图片 {index + 1} · {textOnly ? "仅提取文字，文章不保留图片" : `${asset.kind === "page" ? "原页预览" : "正文图片"} · ${asset.placement === "anchor" ? "已放回段落附近" : "按页保留"}`}
              {asset.status === "pending" ? " · 等待识别" : asset.status === "failed" ? " · 识别失败" : asset.status === "skipped" ? imagePolicy === "images_only" ? " · 按策略跳过识别" : " · 已保留，无附加识别内容" : asset.recognition === "ocr" ? " · OCR 已完成" : " · 图片描述已完成"}
            </p>
            {!textOnly ? <SavedImage key={asset.imageKey} imageKey={asset.imageKey} label={`第 ${page.pageNo} 页图片 ${index + 1}`} /> : null}
            {asset.error === "quota_exceeded" ? <p className="text-xs text-amber-700 dark:text-amber-400">识别服务余额或额度不足{!textOnly ? "，原图已保存" : ""}。</p> : asset.error === "unauthorized" ? <p className="text-xs text-amber-700 dark:text-amber-400">识别服务认证失败，请检查模型配置。</p> : null}
            {asset.markdown ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{asset.markdown}</p> : null}
          </div>
        ))}
        {!textOnly && page.imageKey && !assets.some((asset) => asset.kind === "page") ? (
          <details className="rounded border px-3 py-2" onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">查看原页对照（不插入正文）</summary>
            {previewOpen ? <div className="mt-2"><SavedImage key={page.imageKey} imageKey={page.imageKey} label={`第 ${page.pageNo} 页原页预览`} /></div> : null}
          </details>
        ) : null}
      </div> : null}
    </details>
  )
}
