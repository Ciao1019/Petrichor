import * as React from "react"

const HIGHLIGHT_CLASSES = [
  "rounded-md",
  "bg-primary/10",
  "ring-2",
  "ring-primary/30",
  "transition-colors",
] as const

const BLOCK_SELECTOR = [
  '[data-article-block="paragraph"]',
  "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "td", "th",
].join(", ")

interface CitationLocation {
  index: number | null
  sourceId: string
  chunkId: string
  snippet: string
  highlightTerms: string[]
}

function cleanCitationText(value: string) {
  return value
    .replace(/---\s*above content is overlap of prefix chunk\s*---/gi, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`>#*_~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeCitationText(value: string) {
  return cleanCitationText(value).toLowerCase().replace(/\s+/g, "")
}

function parseCitationLocation(search: string): CitationLocation | null {
  if (!search) return null
  const params = new URLSearchParams(search)
  const hasPayload = ["citeIndex", "citeSourceId", "citeChunkId", "citeSnippet", "citeTerms"]
    .some((key) => params.has(key))
  if (!hasPayload) return null
  const indexValue = params.get("citeIndex")
  const parsedIndex = indexValue ? Number.parseInt(indexValue, 10) : null
  const highlightTerms = (params.get("citeTerms") || "")
    .split("\n")
    .map((item) => cleanCitationText(item))
    .filter(Boolean)
  return {
    index: parsedIndex && Number.isFinite(parsedIndex) && parsedIndex > 0 ? parsedIndex : null,
    sourceId: params.get("citeSourceId")?.trim() || "",
    chunkId: params.get("citeChunkId")?.trim() || "",
    snippet: cleanCitationText(params.get("citeSnippet") || ""),
    highlightTerms: Array.from(new Set(highlightTerms)),
  }
}

function buildSnippetCandidates(snippet: string) {
  const cleaned = cleanCitationText(snippet)
  if (!cleaned) return []
  return Array.from(new Set(cleaned
    .split(/[。！？!?；;，,\n]/)
    .map((item) => cleanCitationText(item))
    .filter((item) => item.length >= 4)
    .sort((left, right) => right.length - left.length)
    .slice(0, 6)))
}

function scoreCitationBlock(block: HTMLElement, snippetCandidates: string[], highlightTerms: string[]) {
  const rawText = cleanCitationText(block.textContent || "")
  const normalizedBlockText = normalizeCitationText(rawText)
  if (!normalizedBlockText) return Number.NEGATIVE_INFINITY

  let score = 0
  for (const candidate of snippetCandidates) {
    const normalizedCandidate = normalizeCitationText(candidate)
    if (!normalizedCandidate) continue
    if (normalizedBlockText.includes(normalizedCandidate)) {
      score = Math.max(score, 1000 + normalizedCandidate.length)
    } else if (normalizedCandidate.length >= 12 && normalizedCandidate.includes(normalizedBlockText) && normalizedBlockText.length >= 8) {
      score = Math.max(score, 760 + normalizedBlockText.length)
    }
  }

  const isHeading = /^h[1-6]$/.test(block.tagName.toLowerCase())
  for (const [termIndex, term] of highlightTerms.entries()) {
    const normalizedTerm = normalizeCitationText(term)
    if (!normalizedTerm || !normalizedBlockText.includes(normalizedTerm)) continue
    score += 24 + Math.min(normalizedTerm.length, 24)
    if (isHeading) {
      score += termIndex === 0 ? 1400 : 500
      if (normalizedBlockText === normalizedTerm) score += 300
    }
  }

  const tagName = block.tagName.toLowerCase()
  if (tagName === "li" || tagName === "blockquote" || block.dataset.articleBlock === "paragraph") score += 18
  else if (/^h[1-6]$/.test(tagName)) score += 8
  return score
}

interface CitationNavigationOptions {
  search: string
  loading: boolean
  articleId: string
  contentLength: number
}

/** 管理引用定位、高亮以及编辑器目录浮层的位置。 */
export function useArticleCitationNavigation({ search, loading, articleId, contentLength }: CitationNavigationOptions) {
  const editorWrapperRef = React.useRef<HTMLDivElement>(null)
  const highlightedBlockRef = React.useRef<HTMLElement | null>(null)
  const highlightTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLocateKeyRef = React.useRef("")
  const [tocRight, setTocRight] = React.useState<number | null>(null)
  const [tocTop, setTocTop] = React.useState<number | null>(null)
  const citation = React.useMemo(() => parseCitationLocation(search), [search])

  const clearHighlight = React.useCallback(() => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    highlightTimerRef.current = null
    if (highlightedBlockRef.current) highlightedBlockRef.current.classList.remove(...HIGHLIGHT_CLASSES)
    highlightedBlockRef.current = null
  }, [])

  const highlight = React.useCallback((target: HTMLElement) => {
    clearHighlight()
    target.classList.add(...HIGHLIGHT_CLASSES)
    highlightedBlockRef.current = target
    highlightTimerRef.current = setTimeout(() => {
      if (highlightedBlockRef.current === target) target.classList.remove(...HIGHLIGHT_CLASSES)
      if (highlightedBlockRef.current === target) highlightedBlockRef.current = null
      highlightTimerRef.current = null
    }, 4200)
  }, [clearHighlight])

  const findTarget = React.useCallback((payload: CitationLocation) => {
    const editorRoot = editorWrapperRef.current?.querySelector(".plate-editor-content")
    if (!(editorRoot instanceof HTMLElement)) return null
    const blocks = Array.from(editorRoot.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
      .filter((element) => cleanCitationText(element.textContent || "").length > 0)
    const snippets = buildSnippetCandidates(payload.snippet)
    const terms = Array.from(new Set(payload.highlightTerms.map(cleanCitationText).filter((item) => item.length >= 2)))
    let bestTarget: HTMLElement | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const block of blocks) {
      const score = scoreCitationBlock(block, snippets, terms)
      if (score > bestScore) {
        bestScore = score
        bestTarget = block
      }
    }
    return bestScore > 0 ? bestTarget : null
  }, [])

  React.useLayoutEffect(() => {
    const calcRight = () => {
      const element = editorWrapperRef.current
      if (!element) return
      setTocRight(Math.max(4, window.innerWidth - element.getBoundingClientRect().right + 8))
    }
    calcRight()
    const observer = new ResizeObserver(calcRight)
    observer.observe(document.documentElement)
    if (editorWrapperRef.current) observer.observe(editorWrapperRef.current)
    window.addEventListener("resize", calcRight)
    return () => { observer.disconnect(); window.removeEventListener("resize", calcRight) }
  }, [])

  const calcTop = React.useCallback(() => {
    const element = editorWrapperRef.current
    if (!element) return
    const rect = element.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    setTocTop(Math.min(Math.max(viewportHeight * 0.2, Math.max(rect.top + 52, 0)), viewportHeight * 0.75))
  }, [])

  React.useLayoutEffect(() => {
    calcTop()
    window.addEventListener("resize", calcTop)
    return () => window.removeEventListener("resize", calcTop)
  }, [calcTop])

  React.useEffect(() => {
    window.addEventListener("scroll", calcTop, { passive: true })
    return () => window.removeEventListener("scroll", calcTop)
  }, [calcTop])

  React.useEffect(() => () => clearHighlight(), [clearHighlight])

  React.useEffect(() => {
    if (loading || !articleId || !citation) return
    const locateKey = [articleId, search, contentLength, citation.chunkId, citation.sourceId, citation.index ?? ""].join("|")
    if (lastLocateKeyRef.current === locateKey) return
    let cancelled = false
    let frame = 0
    let attempt = 0
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const tryLocate = () => {
      if (cancelled) return
      const target = findTarget(citation)
      if (target) {
        lastLocateKeyRef.current = locateKey
        target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center", inline: "nearest" })
        highlight(target)
      } else if (++attempt < 24) {
        frame = window.requestAnimationFrame(tryLocate)
      }
    }
    frame = window.requestAnimationFrame(tryLocate)
    return () => {
      cancelled = true
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [articleId, citation, contentLength, findTarget, highlight, loading, search])

  return { editorWrapperRef, tocRight, tocTop }
}
