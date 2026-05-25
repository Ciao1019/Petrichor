import { cn } from "@/lib/utils"
import React, { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { codeToHtml } from "shiki"
import { Check, Copy } from "lucide-react"

export type CodeBlockProps = {
  children?: React.ReactNode
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "border-border bg-card text-card-foreground rounded-xl",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type CodeBlockCodeProps = {
  code: string
  language?: string
  theme?: string
  showToolbar?: boolean
  showLineNumbers?: boolean
  className?: string
} & React.HTMLProps<HTMLDivElement>

function normalizeLanguage(value: string | undefined): string {
  const raw = (value || "").trim().toLowerCase()
  if (!raw || raw === "plaintext" || raw === "text") return "text"
  return raw
}

async function copyToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  if (typeof document === "undefined") {
    throw new Error("clipboard unavailable")
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "true")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.top = "-9999px"
  document.body.appendChild(textarea)
  textarea.select()
  const ok = document.execCommand("copy")
  document.body.removeChild(textarea)
  if (!ok) {
    throw new Error("copy failed")
  }
}

function CodeBlockCode({
  code,
  language = "tsx",
  theme,
  showToolbar = true,
  showLineNumbers = true,
  className,
  ...props
}: CodeBlockCodeProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { resolvedTheme } = useTheme()
  const isDark =
    resolvedTheme === "dark" ||
    (resolvedTheme === undefined &&
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"))
  const effectiveTheme = theme ?? (isDark ? "github-dark" : "github-light")
  const displayLanguage = normalizeLanguage(language)

  useEffect(() => {
    let cancelled = false
    async function highlight() {
      if (!code) {
        if (!cancelled) {
          setHighlightedHtml("<pre><code></code></pre>")
        }
        return
      }

      try {
        const html = await codeToHtml(code, { lang: language, theme: effectiveTheme })
        if (!cancelled) {
          setHighlightedHtml(html)
        }
      } catch {
        try {
          const html = await codeToHtml(code, { lang: "plaintext", theme: effectiveTheme })
          if (!cancelled) {
            setHighlightedHtml(html)
          }
        } catch {
          if (!cancelled) {
            setHighlightedHtml(null)
          }
        }
      }
    }
    highlight()
    return () => {
      cancelled = true
    }
  }, [code, language, effectiveTheme])

  const handleCopy = React.useCallback(async () => {
    try {
      await copyToClipboard(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }, [code])

  const classNames = cn(
    "w-full text-[13px]",
    showLineNumbers && "codeblock-lines",
    className
  )

  // SSR fallback: render plain code if not hydrated yet
  return (
    <div className={classNames} {...props}>
      {showToolbar ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/25 px-3 py-2">
          <div className="text-muted-foreground font-mono text-xs tabular-nums">
            {displayLanguage}
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              "text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border border-border bg-background/30 px-2 py-1 text-xs transition-colors",
              copied && "text-foreground"
            )}
            aria-label="复制代码"
          >
            {copied ? (
              <>
                <Check className="size-3.5" />
                已复制
              </>
            ) : (
              <>
                <Copy className="size-3.5" />
                复制
              </>
            )}
          </button>
        </div>
      ) : null}

      {highlightedHtml ? (
        <div
          className="w-full overflow-x-auto [&>pre]:m-0 [&>pre]:px-4 [&>pre]:py-4 [&>pre]:!bg-transparent"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <div className="w-full overflow-x-auto">
          <pre className="m-0 px-4 py-4">
            <code>{code}</code>
          </pre>
        </div>
      )}
    </div>
  )
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>

function CodeBlockGroup({
  children,
  className,
  ...props
}: CodeBlockGroupProps) {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock }
