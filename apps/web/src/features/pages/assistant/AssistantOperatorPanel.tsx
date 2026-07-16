"use client"

import * as React from "react"
import { Brain, Loader2, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  assistantApi,
  type AssistantOperatorEvolutionProposal,
  type AssistantOperatorSkillPending,
} from "@/lib/api"

export function AssistantOperatorPanel() {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [allowed, setAllowed] = React.useState(true)
  const [pendings, setPendings] = React.useState<AssistantOperatorSkillPending[]>([])
  const [proposals, setProposals] = React.useState<AssistantOperatorEvolutionProposal[]>([])
  const [running, setRunning] = React.useState(false)
  const [targetName, setTargetName] = React.useState("article-write")
  const [hint, setHint] = React.useState("")

  const refresh = React.useCallback(async () => {
    setLoading(true)
    try {
      const [skills, evo] = await Promise.all([
        assistantApi.operatorSkillsPendingList(),
        assistantApi.operatorEvolutionList({ status: "pending" }),
      ])
      setPendings(skills.data.items)
      setProposals(evo.data.items)
      setAllowed(true)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes("403") || msg.includes("assistant_operator_only") || msg.includes("无权限")) {
        setAllowed(false)
      } else {
        toast.error(msg || "加载失败")
      }
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs">
          <Brain className="size-3.5" />
          记忆进化
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>操作员记忆与进化</SheetTitle>
          <SheetDescription>
            审批待合并 skill；手动触发进化提案。仅超级管理员可用。
          </SheetDescription>
        </SheetHeader>
        {!allowed ? (
          <p className="text-muted-foreground mt-4 text-sm">当前账号不是操作员，无法使用此面板。</p>
        ) : (
          <ScrollArea className="mt-4 flex-1 pr-3">
            <div className="space-y-6 pb-8">
              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">待审批 Skills</h3>
                  <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
                    {loading ? <Loader2 className="size-3.5 animate-spin" /> : "刷新"}
                  </Button>
                </div>
                {pendings.length === 0 ? (
                  <p className="text-muted-foreground text-xs">暂无待审批项</p>
                ) : (
                  pendings.map((item) => (
                    <div key={item.id} className="rounded-md border p-3 text-sm">
                      <div className="font-medium">{item.gist}</div>
                      <div className="text-muted-foreground mt-1 text-xs">
                        {item.action} · {item.skillName}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await assistantApi.operatorSkillsPendingResolve({
                                pendingId: item.id,
                                decision: "approve",
                              })
                              toast.success("已批准")
                              await refresh()
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : "批准失败")
                            }
                          }}
                        >
                          批准
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              await assistantApi.operatorSkillsPendingResolve({
                                pendingId: item.id,
                                decision: "reject",
                              })
                              toast.message("已拒绝")
                              await refresh()
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : "拒绝失败")
                            }
                          }}
                        >
                          拒绝
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">手动进化</h3>
                <label className="text-muted-foreground block text-xs">
                  目标 skill 名（targetType=skill）
                  <input
                    className="border-input bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                    value={targetName}
                    onChange={(event) => setTargetName(event.target.value)}
                  />
                </label>
                <label className="text-muted-foreground block text-xs">
                  提示（可选）
                  <input
                    className="border-input bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
                    value={hint}
                    onChange={(event) => setHint(event.target.value)}
                    placeholder="希望更强调 preview 再落库"
                  />
                </label>
                <Button
                  type="button"
                  className="gap-1.5"
                  disabled={running || !targetName.trim()}
                  onClick={async () => {
                    setRunning(true)
                    try {
                      const result = await assistantApi.operatorEvolutionRun({
                        targetType: "skill",
                        targetName: targetName.trim(),
                        hint: hint.trim() || null,
                      })
                      toast.success(`已生成提案 #${result.data.proposalId}`)
                      await refresh()
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "生成失败")
                    } finally {
                      setRunning(false)
                    }
                  }}
                >
                  {running ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                  生成 skill 进化提案
                </Button>
              </section>

              <section className="space-y-2">
                <h3 className="text-sm font-medium">待处理进化提案</h3>
                {proposals.length === 0 ? (
                  <p className="text-muted-foreground text-xs">暂无 pending 提案</p>
                ) : (
                  proposals.map((item) => (
                    <div key={item.id} className="rounded-md border p-3 text-sm">
                      <div className="font-medium">
                        {item.targetType}
                        {item.targetName ? ` · ${item.targetName}` : ""}
                      </div>
                      <p className="text-muted-foreground mt-1 line-clamp-3 text-xs whitespace-pre-wrap">
                        {item.rationaleMd}
                      </p>
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer">查看 after 预览</summary>
                        <pre className="bg-muted mt-1 max-h-40 overflow-auto rounded p-2 whitespace-pre-wrap">
                          {item.afterMd.slice(0, 2000)}
                        </pre>
                      </details>
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          onClick={async () => {
                            try {
                              await assistantApi.operatorEvolutionResolve({
                                proposalId: item.id,
                                decision: "accept",
                              })
                              toast.success("已合入")
                              await refresh()
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : "合入失败")
                            }
                          }}
                        >
                          接受合入
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            try {
                              await assistantApi.operatorEvolutionResolve({
                                proposalId: item.id,
                                decision: "reject",
                              })
                              toast.message("已拒绝")
                              await refresh()
                            } catch (error) {
                              toast.error(error instanceof Error ? error.message : "拒绝失败")
                            }
                          }}
                        >
                          拒绝
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </section>
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}
