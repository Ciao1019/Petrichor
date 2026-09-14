import type { DocumentImportImagePolicy } from "@/lib/api"

export const IMAGE_POLICY_LABELS: Record<DocumentImportImagePolicy, string> = {
  keep_and_recognize: "保留图片并识别",
  text_only: "仅识别文字",
  images_only: "仅保留图片",
}

export const IMAGE_POLICY_DESCRIPTIONS: Record<DocumentImportImagePolicy, string> = {
  keep_and_recognize: "图片保留在正文中；扫描文字和截图做 OCR，照片与图表补充描述。",
  text_only: "只提取图片中的可见文字，不补图片描述，文章不插入图片或原页预览。",
  images_only: "图片保留在正文中，跳过图片分类、OCR 和描述，不消耗图片识别额度。",
}
