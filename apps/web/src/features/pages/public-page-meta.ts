import * as React from "react"

function updateHeadElement(
  selector: string,
  tagName: "meta" | "link",
  attributes: Record<string, string>,
) {
  const existing = document.head.querySelector<HTMLElement>(selector)
  const element = existing ?? document.createElement(tagName)
  const previous = new Map<string, string | null>()
  for (const [name, value] of Object.entries(attributes)) {
    previous.set(name, element.getAttribute(name))
    element.setAttribute(name, value)
  }
  if (!existing) document.head.appendChild(element)

  return () => {
    if (!existing) {
      element.remove()
      return
    }
    for (const [name, value] of previous) {
      if (value === null) element.removeAttribute(name)
      else element.setAttribute(name, value)
    }
  }
}

/** 为公开 SPA 页面维护标题、摘要、Canonical 与 Open Graph 元数据。 */
export function usePublicPageMeta(title: string, description: string, canonicalPath: string) {
  React.useEffect(() => {
    const previousTitle = document.title
    const normalizedTitle = title.trim() || "Petrichor"
    const normalizedDescription = description.trim() || "公开知识库、语义 Wiki 与可追溯知识。"
    const canonical = new URL(canonicalPath, window.location.origin).toString()
    document.title = normalizedTitle

    const cleanups = [
      updateHeadElement('meta[name="description"]', "meta", { name: "description", content: normalizedDescription }),
      updateHeadElement('meta[property="og:title"]', "meta", { property: "og:title", content: normalizedTitle }),
      updateHeadElement('meta[property="og:description"]', "meta", {
        property: "og:description",
        content: normalizedDescription,
      }),
      updateHeadElement('meta[property="og:type"]', "meta", { property: "og:type", content: "website" }),
      updateHeadElement('meta[property="og:url"]', "meta", { property: "og:url", content: canonical }),
      updateHeadElement('link[rel="canonical"]', "link", { rel: "canonical", href: canonical }),
    ]

    return () => {
      cleanups.reverse().forEach((cleanup) => cleanup())
      document.title = previousTitle
    }
  }, [canonicalPath, description, title])
}
