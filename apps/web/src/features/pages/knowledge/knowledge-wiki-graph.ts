import type {
  KnowledgeBaseWikiGraphResponse,
  SiteGraphPayload,
  SiteGraphPayloadLink,
  SiteGraphPayloadNode,
} from "@/lib/api"

/**
 * 把 Wiki 图谱响应折算成全站星图的点群载荷，直接喂给 `graph-runtime`。
 *
 * 复用星图那套 kind 而不是另造一套：运行时的配色、半径、层级布局和标签样式全部按
 * root/section/article/concept/entity/tag 分支写死，换一套枚举等于把运行时抄一遍。
 * 语义对应关系：知识库=root、分类=section、文章摘要=article、其他页面=tag。
 */

/** 未标注分类的概念/实体归到这里，与知识空间侧栏的分组口径保持一致 */
export const WIKI_GRAPH_UNCATEGORIZED = "未分类"

export const WIKI_GRAPH_ROOT_ID = "wiki:root"
const SOURCE_SECTION_ID = "wiki:section:source"
const OTHER_SECTION_ID = "wiki:section:other"
const CATEGORY_PREFIX = "wiki:category:"
/** 页面节点的 route 前缀：宿主组件靠它把双击/「打开知识页」还原成 pageKey */
const PAGE_ROUTE_PREFIX = "wiki:page:"

/** Wiki 页面类型 → 星图节点类型 */
const KIND_BY_PAGE_KIND: Record<string, SiteGraphPayloadNode["kind"]> = {
  index: "section",
  source: "article",
  concept: "concept",
  entity: "entity",
  comparison: "tag",
  answer: "tag",
  log: "tag",
}

const PAGE_KIND_LABEL: Record<string, string> = {
  index: "Wiki 索引",
  source: "文章摘要",
  entity: "实体",
  concept: "概念",
  comparison: "对比",
  answer: "答案",
  log: "日志",
}

/** 出链的 linkType 是模型写的自由文本，常见的几个翻成中文，其余原样显示 */
const RELATION_LABEL: Record<string, string> = {
  index: "收录",
  extracts: "摘录",
  related: "相关",
  mentions: "提及",
  contains: "包含",
  part_of: "属于",
  compares: "对比",
  answers: "解答",
}

export function wikiGraphPageRoute(pageKey: string): string {
  return `${PAGE_ROUTE_PREFIX}${pageKey}`
}

/** 反解 route；不是页面节点（分类、知识库根）时返回 null */
export function wikiGraphRoutePageKey(route: string): string | null {
  return route.startsWith(PAGE_ROUTE_PREFIX) ? route.slice(PAGE_ROUTE_PREFIX.length) : null
}

function formatDate(value: string): string | null {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString()
}

function makeNode(
  node: Pick<SiteGraphPayloadNode, "id" | "label" | "kind" | "parentId">
    & Partial<SiteGraphPayloadNode>,
): SiteGraphPayloadNode {
  return {
    route: null,
    summary: "",
    attributes: [],
    aliases: [],
    topSectionId: null,
    weight: 0,
    ...node,
  }
}

function structureLink(parentId: string, childId: string): SiteGraphPayloadLink {
  return { source: parentId, target: childId, kind: "structure", relation: "包含" }
}

/** 顶层分类 = 根的直接子节点，与站点星图 assignTopSections 同口径 */
function assignTopSections(nodes: SiteGraphPayloadNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (node.id === WIKI_GRAPH_ROOT_ID) continue
    let current: SiteGraphPayloadNode | undefined = node
    const visited = new Set<string>()
    while (current?.parentId && !visited.has(current.id)) {
      visited.add(current.id)
      if (current.parentId === WIKI_GRAPH_ROOT_ID) break
      current = byId.get(current.parentId)
    }
    node.topSectionId = current?.parentId === WIKI_GRAPH_ROOT_ID ? current.id : node.id
  }
}

export function buildWikiGraphPayload(graph: KnowledgeBaseWikiGraphResponse): SiteGraphPayload {
  const nodes: SiteGraphPayloadNode[] = []
  const links: SiteGraphPayloadLink[] = []

  nodes.push(makeNode({
    id: WIKI_GRAPH_ROOT_ID,
    label: graph.knowledgeBaseName || "知识库",
    kind: "root",
    parentId: null,
    summary: `${graph.stats.pageCount} 个知识页面 · ${graph.stats.linkCount} 条关系`,
  }))

  // 分类节点按需创建：一条 categoryPath 逐级建父子，避免为空目录先铺一层
  const sectionIds = new Set<string>()
  const ensureSection = (id: string, label: string, parentId: string) => {
    if (sectionIds.has(id)) return id
    sectionIds.add(id)
    nodes.push(makeNode({ id, label, kind: "section", parentId }))
    links.push(structureLink(parentId, id))
    return id
  }
  const ensureCategoryPath = (categoryPath: string[]) => {
    const path = categoryPath.filter((name) => name.trim().length > 0)
    const effective = path.length > 0 ? path : [WIKI_GRAPH_UNCATEGORIZED]
    let parentId = WIKI_GRAPH_ROOT_ID
    let id = CATEGORY_PREFIX
    for (const name of effective) {
      id = `${id}${name}/`
      ensureSection(id, name, parentId)
      parentId = id
    }
    return id
  }

  const pageNodeIds = new Set<string>()
  for (const page of graph.nodes) {
    const kind = KIND_BY_PAGE_KIND[page.kind] ?? "tag"
    // 索引页本身就是枢纽，直接挂在知识库根下；概念/实体走分类目录；
    // 文章摘要与零散页面各给一个固定分区，免得几百个叶子直接糊在根上。
    let parentId: string
    if (kind === "section") parentId = WIKI_GRAPH_ROOT_ID
    else if (kind === "concept" || kind === "entity") parentId = ensureCategoryPath(page.categoryPath)
    else if (kind === "article") parentId = ensureSection(SOURCE_SECTION_ID, "文章摘要", WIKI_GRAPH_ROOT_ID)
    else parentId = ensureSection(OTHER_SECTION_ID, "其他页面", WIKI_GRAPH_ROOT_ID)

    const attributes = [{ name: "类型", value: PAGE_KIND_LABEL[page.kind] ?? page.kind }]
    if (page.categoryPath.length > 0) {
      attributes.push({ name: "分类", value: page.categoryPath.join(" / ") })
    }
    if (page.sourceCount > 0) {
      attributes.push({ name: "来源引用", value: `${page.sourceCount} 条` })
    }
    const updatedAt = formatDate(page.updatedAt)
    if (updatedAt) attributes.push({ name: "更新于", value: updatedAt })

    pageNodeIds.add(page.pageKey)
    nodes.push(makeNode({
      id: page.pageKey,
      label: page.title || page.pageKey,
      kind,
      parentId,
      route: wikiGraphPageRoute(page.pageKey),
      summary: page.summary ?? "",
      attributes,
      aliases: page.aliases,
      weight: page.sourceCount,
    }))
    links.push(structureLink(parentId, page.pageKey))
  }

  for (const link of graph.links) {
    // 服务端已剔除悬空边，这里再挡一次：分类节点与页面同处一个 id 空间，
    // 万一 pageKey 撞上分类前缀，运行时会把边连到错误的节点上。
    if (!pageNodeIds.has(link.fromPageKey) || !pageNodeIds.has(link.toPageKey)) continue
    links.push({
      source: link.fromPageKey,
      target: link.toPageKey,
      kind: "reference",
      relation: RELATION_LABEL[link.linkType] ?? link.linkType,
    })
  }

  assignTopSections(nodes)

  return {
    nodes,
    links,
    stats: {
      nodeCount: nodes.length,
      linkCount: links.length,
      articleCount: graph.stats.sourceCount,
      conceptCount: graph.stats.conceptCount,
    },
    generatedAt: graph.generatedAt,
  }
}
