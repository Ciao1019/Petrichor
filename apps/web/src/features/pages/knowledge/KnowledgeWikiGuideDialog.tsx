"use client"

/**
 * KnowledgeWikiGuideDialog 编译说明书编辑弹窗。
 *
 * 说明书只影响之后的编译，不改动已有页面，所以它是一个独立的配置入口，
 * 状态（读取、草稿、保存）都收在这里，Wiki 面板只需要知道「开没开」和「启没启用」。
 */

import * as React from "react"
import { Loader2 } from "@/components/iconimate"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ModalShell } from "@/components/petrichor-ui/modal-shell"
import { knowledgeBaseWikiAgentApi, type KnowledgeBaseWikiGuideResponse } from "@/lib/api"
import { resolveApiErrorMessage } from "@/features/pages/assistant/assistant-message-utils"

export function KnowledgeWikiGuideDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
  onEnabledChange,
}: {
  knowledgeBaseId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 保存后回报是否已启用，供面板上的徽标显示 */
  onEnabledChange: (enabled: boolean) => void
}) {
  const [guide, setGuide] = React.useState<KnowledgeBaseWikiGuideResponse | null>(null)
  const [draft, setDraft] = React.useState("")
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open || !knowledgeBaseId) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const res = await knowledgeBaseWikiAgentApi.guide(knowledgeBaseId)
        if (cancelled) return
        setGuide(res.data)
        // 没保存过时用模板起手，用户直接在上面改。
        setDraft(res.data.enabled ? res.data.contentMd : (res.data.templateMd ?? ""))
        onEnabledChange(res.data.enabled)
      } catch (error) {
        if (cancelled) return
        toast.error(resolveApiErrorMessage(error, "加载编译说明书失败"))
        onOpenChange(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [open, knowledgeBaseId, onEnabledChange, onOpenChange])

  const save = React.useCallback(async () => {
    if (!knowledgeBaseId) return
    setSaving(true)
    try {
      const res = await knowledgeBaseWikiAgentApi.saveGuide(knowledgeBaseId, draft)
      setGuide(res.data)
      onEnabledChange(res.data.enabled)
      toast.success(res.data.enabled ? "编译说明书已保存，下次编译生效" : "已清空编译说明书，编译回到默认行为")
      onOpenChange(false)
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, "保存编译说明书失败"))
    } finally {
      setSaving(false)
    }
  }, [knowledgeBaseId, draft, onEnabledChange, onOpenChange])

  const maxLength = guide?.maxLength

  return (
    <ModalShell
      open={open}
      onOpenChange={(next) => {
        if (!next && saving) return
        onOpenChange(next)
      }}
      disableClose={saving}
      contentClassName="sm:max-w-3xl"
      title="编译说明书"
      description="保存后会追加到这个知识库每次编译的模型提示里，用来细化抽取偏好、目录约定和页面写法。清空即停用。"
      footer={
        <>
          <Button type="button" variant="secondary" disabled={saving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" disabled={loading || saving} onClick={() => save()}>
            {saving ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
            {saving ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载中…
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-1 py-1">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={saving}
            rows={20}
            spellCheck={false}
            className="min-h-[22rem] font-mono text-xs leading-relaxed"
            placeholder="留空表示不启用，编译行为与从前一致"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              HTML 注释与只有标题没有内容的小节不会进入提示词；它只能细化领域偏好，不能改变输出格式。
            </span>
            <span className={cn(maxLength && draft.length > maxLength && "text-destructive")}>
              {draft.length}
              {maxLength ? ` / ${maxLength}` : null}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            修改只影响之后的编译；要让已有页面套用新约定，保存后再执行一次「更新 Wiki」或「完全重建」。
          </p>
        </div>
      )}
    </ModalShell>
  )
}
