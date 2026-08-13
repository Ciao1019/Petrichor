/**
 * 知识库面包屑名称缓存（sessionStorage）。
 * 树页加载详情后写入，顶栏面包屑读取，避免末级一直显示「浏览」。
 */

const NAME_KEY_PREFIX = "petrichor:kb-name:"

function canUseSessionStorage(): boolean {
  return typeof window !== "undefined" && Boolean(window.sessionStorage)
}

/** 记录知识库名称，供面包屑与同页刷新使用 */
export function rememberKnowledgeBase(kb: {
  id: string
  name: string
  description?: string | null
}) {
  const name = kb.name.trim() || "未命名知识库"
  if (!canUseSessionStorage()) return

  try {
    window.sessionStorage.setItem(`${NAME_KEY_PREFIX}${kb.id}`, name)
  } catch {
    // ignore
  }

  window.dispatchEvent(
    new CustomEvent("petrichor:kb-crumb", { detail: { id: kb.id, name } }),
  )
}

export function rememberKnowledgeBaseCrumb(id: string, name: string) {
  rememberKnowledgeBase({ id, name })
}

export function getKnowledgeBaseCrumbName(id: string): string | null {
  if (!canUseSessionStorage()) return null
  try {
    return window.sessionStorage.getItem(`${NAME_KEY_PREFIX}${id}`)
  } catch {
    return null
  }
}
