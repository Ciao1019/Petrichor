import { Network, Plus, Search, X } from "@/components/iconimate"

import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { SiteGraphAdminNode } from "@/lib/api"
import { KindDot, LockMark, RowActions, StatusBadge, TableSkeleton } from "./SiteGraphConfigPanels"
import {
  ALL_FILTER,
  KIND_LABEL,
  NODE_KIND_OPTIONS,
  SOURCE_LABEL,
  STATUS_OPTIONS,
} from "./site-graph-config-utils"

interface SiteGraphNodeTableProps {
  disabled: boolean
  loading: boolean
  nodes: SiteGraphAdminNode[]
  total: number
  filterActive: boolean
  keyword: string
  kindFilter: string
  statusFilter: string
  onKeywordChange: (value: string) => void
  onKindFilterChange: (value: string) => void
  onStatusFilterChange: (value: string) => void
  onClearFilters: () => void
  onEdit: (node?: SiteGraphAdminNode) => void
  onRequestDelete: (node: SiteGraphAdminNode) => void
}

export function SiteGraphNodeTable({
  disabled,
  loading,
  nodes,
  total,
  filterActive,
  keyword,
  kindFilter,
  statusFilter,
  onKeywordChange,
  onKindFilterChange,
  onStatusFilterChange,
  onClearFilters,
  onEdit,
  onRequestDelete,
}: SiteGraphNodeTableProps) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={keyword} disabled={disabled} onChange={(event) => onKeywordChange(event.target.value)} placeholder="搜索名称 / 节点键 / 摘要" className="h-9 pl-8" />
        </div>
        <Select value={kindFilter} onValueChange={onKindFilterChange} disabled={disabled}>
          <SelectTrigger size="sm" className="w-[7.5rem]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER}>全部类型</SelectItem>
            {NODE_KIND_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={onStatusFilterChange} disabled={disabled}>
          <SelectTrigger size="sm" className="w-[7.5rem]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER}>全部状态</SelectItem>
            {STATUS_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {filterActive ? <Button type="button" variant="ghost" size="sm" onClick={onClearFilters}><X />清除筛选</Button> : null}
        <span className="ml-auto text-xs text-muted-foreground">显示 {nodes.length} / {total}（最多 200 条）</span>
        <Button type="button" size="sm" onClick={() => onEdit()} disabled={disabled}><Plus />新增节点</Button>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        {loading ? (
          <TableSkeleton columns={7} />
        ) : nodes.length === 0 ? (
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Network /></EmptyMedia>
              <EmptyTitle>{filterActive ? "没有匹配的节点" : "还没有节点"}</EmptyTitle>
              <EmptyDescription>{filterActive ? "换个关键词或清除筛选试试。" : "点「Agent 生成」从公开文章抽取，或手动新增一个节点。"}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="max-h-[38rem] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-full pl-4">节点</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>父节点</TableHead>
                  <TableHead className="text-right">层级</TableHead>
                  <TableHead className="text-right">子 / 关系</TableHead>
                  <TableHead>属性</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="pr-4 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {nodes.map((node) => (
                  <TableRow key={node.id} className="group">
                    <TableCell className="max-w-0 pl-4">
                      <div className="truncate font-medium">{node.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">{node.nodeKey}</div>
                    </TableCell>
                    <TableCell><span className="inline-flex items-center gap-1.5 text-xs"><KindDot kind={node.kind} />{KIND_LABEL[node.kind]}</span></TableCell>
                    <TableCell className="max-w-[12rem]"><span className="block truncate font-mono text-[11px] text-muted-foreground">{node.parentKey ?? "—"}</span></TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{node.depth}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{node.childCount} / {node.degree}</TableCell>
                    <TableCell className="max-w-[16rem]">
                      {node.attributes.length === 0 ? <span className="text-xs text-muted-foreground">—</span> : (
                        <div className="flex items-center gap-1">
                          {node.attributes.slice(0, 2).map((attribute) => (
                            <span key={attribute.name} title={`${attribute.name}：${attribute.value}`} className="max-w-[7rem] truncate rounded border bg-muted/50 px-1.5 py-0.5 text-[11px] text-muted-foreground">{attribute.name}: {attribute.value}</span>
                          ))}
                          {node.attributes.length > 2 ? <span className="text-[11px] text-muted-foreground">+{node.attributes.length - 2}</span> : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell><div className="flex items-center gap-1.5"><StatusBadge status={node.status} /><LockMark locked={node.locked} /><span className="text-[11px] text-muted-foreground">{SOURCE_LABEL[node.source]}</span></div></TableCell>
                    <TableCell className="pr-4 text-right">
                      <RowActions disabled={disabled} editLabel="编辑节点" deleteLabel="删除节点" onEdit={() => onEdit(node)} onDelete={() => onRequestDelete(node)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  )
}
