"use client"

import {
  CheckCircle2,
  Loader2,
  Lock,
  LockOpen,
  Pencil,
  Plus,
  Sparkles,
  Trash2
} from "@/components/iconimate"
import * as React from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  type SiteGraphEdgeKind,
  type SiteGraphIssue,
  type SiteGraphNodeKind,
  type SiteGraphOverviewResponse,
  type SiteGraphRunSummary,
  type SiteGraphStatus,
  type SiteGraphValidationReport
} from "@/lib/api"
import {
  EDGE_KIND_OPTIONS,
  KIND_COLOR_VAR,
  KIND_LABEL,
  NODE_KIND_OPTIONS,
  NONE_PARENT,
  RUN_STATUS_META,
  SEVERITY_META,
  STATUS_META,
  STATUS_OPTIONS,
  formatDateTime,
  type EdgeFormState,
  type NodeFormState,
} from "./site-graph-config-utils"

export function MetaDivider() {
    return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
}

export function KindDot({ kind }: { kind: SiteGraphNodeKind }) {
    return (
        <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ background: `var(${KIND_COLOR_VAR[kind]})` }}
        />
    )
}

export function StatusBadge({ status }: { status: SiteGraphStatus }) {
    const meta = STATUS_META[status]
    return (
        <Badge variant="outline" className={`px-1.5 py-0 text-[11px] font-normal ${meta.className}`}>
            {meta.label}
        </Badge>
    )
}

export function LockMark({ locked }: { locked: boolean }) {
    return locked
        ? <Lock className="size-3 text-muted-foreground" aria-label="已锁定" />
        : <LockOpen className="size-3 text-muted-foreground/30" aria-label="未锁定" />
}

export function StatTile({ label, value, accent }: { label: string; value: number; accent: string }) {
    return (
        <div className="relative overflow-hidden rounded-xl border bg-card px-3.5 py-3 transition-colors hover:border-foreground/20">
            <span aria-hidden="true" className="absolute inset-x-0 top-0 h-0.5" style={{ background: accent, opacity: 0.7 }} />
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: accent }} aria-hidden="true" />
                <span className="truncate">{label}</span>
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums leading-none">{value}</div>
        </div>
    )
}

/** 行内操作：默认淡出，悬停/键盘聚焦时才实体化，表格因此清爽很多 */
export function RowActions({
    disabled,
    editLabel,
    deleteLabel,
    onEdit,
    onDelete,
}: {
    disabled: boolean
    editLabel: string
    deleteLabel: string
    onEdit: () => void
    onDelete: () => void
}) {
    return (
        <div className="flex justify-end gap-1 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={editLabel} title={editLabel} onClick={onEdit}>
                <Pencil />
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={deleteLabel}
                title={deleteLabel}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={onDelete}
            >
                <Trash2 />
            </Button>
        </div>
    )
}

export function TableSkeleton({ columns }: { columns: number }) {
    return (
        <div className="divide-y">
            {Array.from({ length: 6 }).map((_, row) => (
                <div key={row} className="flex items-center gap-4 px-4 py-3">
                    {Array.from({ length: columns }).map((__, column) => (
                        <Skeleton key={column} className={`h-4 ${column === 0 ? "w-48" : "flex-1"}`} />
                    ))}
                </div>
            ))}
        </div>
    )
}

export function PanelShell({
    title,
    description,
    action,
    children,
}: {
    title: string
    description: string
    action?: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <section className="flex flex-col rounded-xl border bg-card">
            <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold">{title}</h2>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
                </div>
                {action}
            </header>
            <div className="flex-1 p-4">{children}</div>
        </section>
    )
}

export function ValidationPanel({
    validation,
    loading,
}: {
    validation: SiteGraphValidationReport | null
    loading: boolean
}) {
    const counts = React.useMemo(() => {
        const issues = validation?.issues ?? []
        return {
            error: issues.filter((issue) => issue.severity === "error").length,
            warning: issues.filter((issue) => issue.severity === "warning").length,
            info: issues.filter((issue) => issue.severity === "info").length,
        }
    }, [validation])

    return (
        <PanelShell
            title="校验报告"
            description="存在错误项时禁止发布。生成后自动校验一次，人工改动后可点「重新校验」。"
        >
            {loading ? (
                <div className="space-y-3">
                    <Skeleton className="h-16 w-full rounded-lg" />
                    <Skeleton className="h-4 w-2/3" />
                    <Skeleton className="h-4 w-1/2" />
                </div>
            ) : !validation ? (
                <p className="text-sm text-muted-foreground">尚无校验记录。</p>
            ) : (
                <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/30 px-4 py-3">
                        <div>
                            <div className="text-[11px] text-muted-foreground">评分</div>
                            <div
                                className={`text-3xl font-semibold tabular-nums leading-none ${
                                    validation.passed ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                                }`}
                            >
                                {validation.score}
                            </div>
                        </div>
                        <span aria-hidden="true" className="h-10 w-px shrink-0 bg-border" />
                        <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3 text-xs sm:grid-cols-4">
                            <MetaPair stacked label="节点" value={validation.nodeCount} />
                            <MetaPair stacked label="关系" value={validation.edgeCount} />
                            <MetaPair stacked label="孤立节点" value={validation.orphanCount} />
                            <MetaPair stacked label="最大层级" value={validation.maxDepth} />
                        </dl>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        <IssueCount label="错误" count={counts.error} className="text-destructive" dot="bg-destructive" />
                        <IssueCount label="警告" count={counts.warning} className="text-amber-600 dark:text-amber-400" dot="bg-amber-500" />
                        <IssueCount label="提示" count={counts.info} className="text-muted-foreground" dot="bg-muted-foreground/50" />
                        <span className="ml-auto text-muted-foreground">校验于 {formatDateTime(validation.checkedAt)}</span>
                    </div>

                    {validation.issues.length === 0 ? (
                        <p className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5 text-sm text-emerald-700 dark:text-emerald-400">
                            <CheckCircle2 className="size-4" />
                            没有发现问题。
                        </p>
                    ) : (
                        <ul className="max-h-80 space-y-1 overflow-y-auto pr-1">
                            {validation.issues.map((issue, index) => (
                                <IssueRow key={`${issue.code}-${issue.target}-${index}`} issue={issue} />
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </PanelShell>
    )
}

export function RunPanel({ run, loading }: { run: SiteGraphRunSummary | null; loading: boolean }) {
    return (
        <PanelShell
            title="最近一次生成"
            description="抽取 Agent 的运行记录。"
            action={run ? (
                <Badge variant="outline" className={`shrink-0 ${RUN_STATUS_META[run.status].className}`}>
                    {RUN_STATUS_META[run.status].label}
                </Badge>
            ) : undefined}
        >
            {loading ? (
                <div className="space-y-2">
                    {Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-4 w-full" />)}
                </div>
            ) : !run ? (
                <Empty className="border-0 p-0 md:p-0">
                    <EmptyHeader>
                        <EmptyMedia variant="icon"><Sparkles /></EmptyMedia>
                        <EmptyTitle>尚未运行过抽取 Agent</EmptyTitle>
                        <EmptyDescription>点右上角「Agent 生成」从公开文章抽取节点与关系。</EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                <div className="space-y-3 text-sm">
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
                        <MetaPair label="模式" value={run.mode === "FULL" ? "全量" : "增量"} />
                        <MetaPair label="模型" value={run.modelName ?? "—"} />
                        <MetaPair label="文章数" value={run.articleCount} />
                        <MetaPair label="节点 / 关系" value={`${run.nodeCount} / ${run.edgeCount}`} />
                        <MetaPair label="开始时间" value={formatDateTime(run.startedAt)} />
                        <MetaPair label="结束时间" value={formatDateTime(run.finishedAt)} />
                    </dl>
                    {run.errorMessage ? (
                        <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                            {run.errorMessage}
                        </p>
                    ) : null}
                    {run.warnings.length > 0 ? (
                        <ul className="space-y-1 rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                            {run.warnings.map((warning) => (
                                <li key={warning} className="flex items-start gap-2">
                                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500" aria-hidden="true" />
                                    <span className="min-w-0">{warning}</span>
                                </li>
                            ))}
                        </ul>
                    ) : null}
                </div>
            )}
        </PanelShell>
    )
}

/** stacked 用于宽栏里的指标条：横排 label/value 在宽格子里会被拉开老远，不如上下叠 */
export function MetaPair({ label, value, stacked }: { label: string; value: React.ReactNode; stacked?: boolean }) {
    if (stacked) {
        return (
            <div className="min-w-0">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 truncate text-sm font-medium tabular-nums">{value}</dd>
            </div>
        )
    }
    return (
        <div className="flex items-baseline justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate text-right font-medium tabular-nums">{value}</dd>
        </div>
    )
}

export function IssueCount({ label, count, className, dot }: { label: string; count: number; className: string; dot: string }) {
    return (
        <span className={`inline-flex items-center gap-1.5 ${count === 0 ? "text-muted-foreground/50" : className}`}>
            <span className={`size-1.5 rounded-full ${count === 0 ? "bg-muted-foreground/30" : dot}`} aria-hidden="true" />
            {label} {count}
        </span>
    )
}

export function IssueRow({ issue }: { issue: SiteGraphIssue }) {
    const meta = SEVERITY_META[issue.severity]
    return (
        <li className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50">
            <span className={`mt-[0.4rem] size-1.5 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
            <span className="min-w-0">
                <span className={`text-xs font-medium ${meta.className}`}>{meta.label}</span>
                <span className="mx-1.5 font-mono text-[11px] text-muted-foreground">{issue.target}</span>
                <span className="text-muted-foreground">{issue.message}</span>
            </span>
        </li>
    )
}

/** 表单区块标题，把长表单切成几段，比一整片输入框好扫 */
export function FormSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
    return (
        <section className="space-y-3">
            <div className="flex items-baseline gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
                {hint ? <span className="text-[11px] text-muted-foreground/70">{hint}</span> : null}
            </div>
            {children}
        </section>
    )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            {children}
        </div>
    )
}

export function NodeFormSheet({
    open,
    onOpenChange,
    form,
    setForm,
    nodeOptions,
    disabled,
    onSave,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    form: NodeFormState
    setForm: React.Dispatch<React.SetStateAction<NodeFormState>>
    nodeOptions: SiteGraphOverviewResponse["nodeOptions"]
    disabled: boolean
    onSave: () => void
}) {
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
                <SheetHeader className="border-b">
                    <SheetTitle>{form.id ? "编辑节点" : "新增节点"}</SheetTitle>
                    <SheetDescription>
                        节点键留空时按「类型-名称」自动生成。手工保存的节点会标记为人工维护，Agent 重跑不会覆盖；
                        勾选「锁定」后连属性也不会被覆盖。
                    </SheetDescription>
                </SheetHeader>

                <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
                    <FormSection title="基本信息">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="节点名称">
                                <Input
                                    value={form.name}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                                    placeholder="向量检索"
                                />
                            </Field>
                            <Field label="节点类型">
                                <Select
                                    value={form.kind}
                                    disabled={disabled}
                                    onValueChange={(value) => setForm((current) => ({ ...current, kind: value as SiteGraphNodeKind }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {NODE_KIND_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                                <KindDot kind={option.value} />
                                                {option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        </div>
                        <Field label="摘要（前台悬停展示）">
                            <Textarea
                                value={form.summary}
                                disabled={disabled}
                                rows={3}
                                onChange={(event) => setForm((current) => ({ ...current, summary: event.target.value }))}
                            />
                        </Field>
                    </FormSection>

                    <FormSection title="定位" hint="邻接表层级与站内链接">
                        <Field label="父节点">
                            <Select
                                value={form.parentId}
                                disabled={disabled}
                                onValueChange={(value) => setForm((current) => ({ ...current, parentId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NONE_PARENT}>（无父节点）</SelectItem>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            <KindDot kind={option.kind} />
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="节点键（可空）">
                                <Input
                                    value={form.nodeKey}
                                    disabled={disabled}
                                    className="font-mono text-xs"
                                    onChange={(event) => setForm((current) => ({ ...current, nodeKey: event.target.value }))}
                                    placeholder="concept-向量检索"
                                />
                            </Field>
                            <Field label="站内链接（须以 / 开头）">
                                <Input
                                    value={form.route}
                                    disabled={disabled}
                                    className="font-mono text-xs"
                                    onChange={(event) => setForm((current) => ({ ...current, route: event.target.value }))}
                                    placeholder="/p/abcd1234"
                                />
                            </Field>
                        </div>
                    </FormSection>

                    <FormSection title="属性与别名" hint="属性每行一条，格式 名称=值">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="节点属性">
                                <Textarea
                                    value={form.attributesText}
                                    disabled={disabled}
                                    rows={4}
                                    className="font-mono text-xs"
                                    onChange={(event) => setForm((current) => ({ ...current, attributesText: event.target.value }))}
                                    placeholder={"类别=检索技术\n典型场景=RAG 问答"}
                                />
                            </Field>
                            <Field label="别名（逗号分隔）">
                                <Textarea
                                    value={form.aliasesText}
                                    disabled={disabled}
                                    rows={4}
                                    onChange={(event) => setForm((current) => ({ ...current, aliasesText: event.target.value }))}
                                    placeholder="vector search, 向量搜索"
                                />
                            </Field>
                        </div>
                    </FormSection>

                    <FormSection title="发布控制">
                        <div className="grid gap-3 sm:grid-cols-3">
                            <Field label="权重（影响点半径）">
                                <Input
                                    type="number"
                                    value={form.weight}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, weight: event.target.value }))}
                                />
                            </Field>
                            <Field label="置信度">
                                <Input
                                    type="number"
                                    value={form.confidence}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, confidence: event.target.value }))}
                                />
                            </Field>
                            <Field label="状态">
                                <Select
                                    value={form.status}
                                    disabled={disabled}
                                    onValueChange={(value) => setForm((current) => ({ ...current, status: value as SiteGraphStatus }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {STATUS_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                        </div>
                        <ToggleRow
                            id="node-locked"
                            label="锁定"
                            hint="Agent 重跑时不覆盖该节点的属性"
                            checked={form.locked}
                            disabled={disabled}
                            onCheckedChange={(checked) => setForm((current) => ({ ...current, locked: checked }))}
                        />
                    </FormSection>
                </div>

                <SheetFooter className="flex-row justify-end gap-2 border-t">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={disabled}>
                        取消
                    </Button>
                    <Button type="button" onClick={onSave} disabled={disabled}>
                        {disabled ? <Loader2 className="animate-spin" /> : <Plus />}
                        {form.id ? "保存修改" : "新增节点"}
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    )
}

export function EdgeFormSheet({
    open,
    onOpenChange,
    form,
    setForm,
    nodeOptions,
    disabled,
    onSave,
}: {
    open: boolean
    onOpenChange: (open: boolean) => void
    form: EdgeFormState
    setForm: React.Dispatch<React.SetStateAction<EdgeFormState>>
    nodeOptions: SiteGraphOverviewResponse["nodeOptions"]
    disabled: boolean
    onSave: () => void
}) {
    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
                <SheetHeader className="border-b">
                    <SheetTitle>{form.id ? "编辑关系" : "新增关系"}</SheetTitle>
                    <SheetDescription>
                        关系用于连接不同分支的节点；父子层级请在节点表单里用「父节点」维护。
                    </SheetDescription>
                </SheetHeader>

                <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
                    <FormSection title="连接">
                        <Field label="起点">
                            <Select
                                value={form.fromNodeId}
                                disabled={disabled}
                                onValueChange={(value) => setForm((current) => ({ ...current, fromNodeId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue placeholder="选择起点节点" /></SelectTrigger>
                                <SelectContent>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            <KindDot kind={option.kind} />
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field label="关系名称">
                            <Input
                                value={form.relation}
                                disabled={disabled}
                                onChange={(event) => setForm((current) => ({ ...current, relation: event.target.value }))}
                                placeholder="阐述"
                            />
                        </Field>
                        <Field label="终点">
                            <Select
                                value={form.toNodeId}
                                disabled={disabled}
                                onValueChange={(value) => setForm((current) => ({ ...current, toNodeId: value }))}
                            >
                                <SelectTrigger className="w-full"><SelectValue placeholder="选择终点节点" /></SelectTrigger>
                                <SelectContent>
                                    {nodeOptions.map((option) => (
                                        <SelectItem key={option.id} value={option.id}>
                                            <KindDot kind={option.kind} />
                                            {KIND_LABEL[option.kind]} · {option.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                    </FormSection>

                    <FormSection title="属性" hint="每行一条，格式 名称=值">
                        <Textarea
                            value={form.attributesText}
                            disabled={disabled}
                            rows={3}
                            className="font-mono text-xs"
                            onChange={(event) => setForm((current) => ({ ...current, attributesText: event.target.value }))}
                            placeholder="依据=文中第 2 节"
                        />
                    </FormSection>

                    <FormSection title="发布控制">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Field label="关系类型">
                                <Select
                                    value={form.kind}
                                    disabled={disabled}
                                    onValueChange={(value) => setForm((current) => ({ ...current, kind: value as SiteGraphEdgeKind }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {EDGE_KIND_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field label="状态">
                                <Select
                                    value={form.status}
                                    disabled={disabled}
                                    onValueChange={(value) => setForm((current) => ({ ...current, status: value as SiteGraphStatus }))}
                                >
                                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {STATUS_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </Field>
                            <Field label="权重">
                                <Input
                                    type="number"
                                    value={form.weight}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, weight: event.target.value }))}
                                />
                            </Field>
                            <Field label="置信度">
                                <Input
                                    type="number"
                                    value={form.confidence}
                                    disabled={disabled}
                                    onChange={(event) => setForm((current) => ({ ...current, confidence: event.target.value }))}
                                />
                            </Field>
                        </div>
                        <ToggleRow
                            id="edge-directed"
                            label="有向关系"
                            hint="关闭后视为双向，前台不画箭头"
                            checked={form.directed}
                            disabled={disabled}
                            onCheckedChange={(checked) => setForm((current) => ({ ...current, directed: checked }))}
                        />
                        <ToggleRow
                            id="edge-locked"
                            label="锁定"
                            hint="Agent 重跑时不覆盖该关系"
                            checked={form.locked}
                            disabled={disabled}
                            onCheckedChange={(checked) => setForm((current) => ({ ...current, locked: checked }))}
                        />
                    </FormSection>
                </div>

                <SheetFooter className="flex-row justify-end gap-2 border-t">
                    <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={disabled}>
                        取消
                    </Button>
                    <Button type="button" onClick={onSave} disabled={disabled}>
                        {disabled ? <Loader2 className="animate-spin" /> : <Plus />}
                        {form.id ? "保存修改" : "新增关系"}
                    </Button>
                </SheetFooter>
            </SheetContent>
        </Sheet>
    )
}

export function ToggleRow({
    id,
    label,
    hint,
    checked,
    disabled,
    onCheckedChange,
}: {
    id: string
    label: string
    hint: string
    checked: boolean
    disabled: boolean
    onCheckedChange: (checked: boolean) => void
}) {
    return (
        <div className="flex items-center justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2.5">
            <div className="min-w-0">
                <Label htmlFor={id} className="text-sm font-medium">{label}</Label>
                <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
            <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
        </div>
    )
}
