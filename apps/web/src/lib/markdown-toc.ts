import GithubSlugger from "github-slugger"
import { marked, type Token } from "marked"

export type TocItem = {
  id: string
  level: number
  text: string
}

function normalizeHeadingText(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

function collectHeadingTokens(tokens: Token[], slugger: GithubSlugger, toc: TocItem[]) {
  for (const token of tokens) {
    if (token.type === "heading") {
      const text = normalizeHeadingText(token.text)
      if (text) {
        toc.push({
          id: slugger.slug(text),
          level: token.depth,
          text,
        })
      }
      continue
    }

    if (token.type === "list") {
      for (const item of token.items) {
        if (Array.isArray(item.tokens)) {
          collectHeadingTokens(item.tokens, slugger, toc)
        }
      }
      continue
    }

    const nested = (token as { tokens?: unknown }).tokens
    if (Array.isArray(nested)) {
      collectHeadingTokens(nested as Token[], slugger, toc)
    }
  }
}

export function buildToc(markdown: string): TocItem[] {
  if (!markdown) return []
  const toc: TocItem[] = []
  const slugger = new GithubSlugger()
  const tokens = marked.lexer(markdown) as Token[]
  collectHeadingTokens(tokens, slugger, toc)

  return toc
}
