# 前台知识门户、公开 Wiki、统一搜索与订阅开发计划

> 实施状态：服务端公开作用域、Wiki、统一搜索和订阅能力已完整实现。根据 2026-09-03 的产品调整，公开前台恢复为原文章归档界面，暂不展示 Wiki、图谱与统一搜索页面；对应路径统一返回首页，后端能力保留。

## 1. 目标

本轮把 Petrichor 的公开前台从“个人博客文章归档”调整为“公开知识门户”，但不推翻现有 Retypeset 视觉体系，也不大改文章阅读页。

交付范围：

1. 前台弱化博客感，突出知识探索、Wiki、关系和问答。
2. 增加公开 Wiki 首页、页面详情和关系图谱。
3. 提供全文搜索与语义搜索的统一入口。
4. 提供 RSS 2.0 与 Atom 1.0 订阅。
5. 所有匿名入口只允许访问真正公开的文章及其安全派生内容。

## 2. 非目标

本轮不做以下事项：

- 不重做公开文章阅读器和后台布局。
- 不引入新的前端设计系统或图谱运行时。
- 不允许匿名用户编辑 Wiki、提交 Patch 或访问后台 Wiki 检查信息。
- 不把密码分享、过期分享或阅后即焚内容纳入公开索引。
- 不在本轮处理团队权限、文章版本历史和外部数据源同步。

## 3. 当前实现与必须先解决的问题

### 3.1 已有能力

- `/` 已有公开文章列表，使用 Retypeset 主题。
- `/graph` 已有全站星图和可复用的 `SiteGraphExplorer`。
- 后台知识空间已有 Wiki 页面列表、详情和 Wiki 图谱转换器。
- `/api/public/wiki/page` 已能为公开问答弹窗返回单个 Wiki 页面。
- 文章切片和 Wiki Tree 已有全文索引及向量字段。
- `/api/public/article/search` 已有基于 `ILIKE + pg_trgm` 的文章搜索。

### 3.2 当前公开边界风险

在增加公开 Wiki 和统一搜索之前，必须先统一公开范围：

- 当前公开文章列表和文章搜索只检查 `enabled=true`、未撤销，仍会列出已过期或带密码的分享；搜索还会读取这些文章的正文参与匹配。
- 当前公开 Wiki 只要页面有一个来源文章公开，就会返回整页 `content_md`；若同一页面同时引用私有文章，可能暴露由私有来源生成的内容。
- 当前公开 Wiki 的邻居标题和摘要没有按公开范围再次过滤。
- 公开文章、Wiki、公开问答和站点图谱各自维护可见性 SQL，后续容易继续漂移。

因此，本轮第一个里程碑不是 UI，而是建立唯一的“匿名公开作用域”。

## 4. 公开内容判定规则

### 4.1 可匿名索引的文章

文章只有同时满足以下条件，才允许出现在首页、Wiki、图谱、搜索、公开问答、RSS 和 Atom 中：

```sql
s.enabled = true
AND s.revoked_at IS NULL
AND (s.expires_at IS NULL OR s.expires_at > now())
AND COALESCE(BTRIM(s.password_hash), '') = ''
AND COALESCE(BTRIM(s.share_code), '') <> ''
```

具体约定：

| 分享状态 | 分享详情页 | 首页/搜索/Wiki/图谱/Feed |
| --- | --- | --- |
| 永久分享、无密码 | 可访问 | 可出现 |
| 带密码分享 | 输对密码后可访问 | 不出现 |
| 已过期 | 不可访问 | 不出现 |
| 已撤销或禁用 | 不可访问 | 不出现 |
| 阅后即焚 | 仅走 Burn 流程 | 不出现 |

### 4.2 可匿名读取的 Wiki 页面

采用“宁可少展示，也不泄露”的严格规则：

- 页面未归档。
- 页面至少有一个 `source_ref`。
- 页面所有 `source_ref.article_id` 都属于可匿名索引文章。
- `log` 页面永不公开。
- `index` 页面不直接返回数据库中的聚合正文，改为根据当前可见页面动态生成公开目录。
- 页面出链和反链只有在两端页面都满足上述规则时才返回。
- 页面来源列表只返回公开文章的 `shareCode` 路由，不返回后台 ID 路由。

混合引用公开与私有文章的 Wiki 页面整体隐藏；不能通过删除引用列表来假装正文已经脱敏。

### 4.3 搜索索引的二次校验

即使异步索引尚未清理，查询 SQL 也必须实时连接公开分享作用域。撤销分享、设置密码或到期后，内容必须立即从匿名查询结果消失，不能依赖后台任务最终一致性。

### 4.4 附件

公开 Wiki 渲染附件时，只允许签发以下对象的读取地址：

- 对象键确实出现在当前可见的公开文章或公开 Wiki 页面中。
- 请求同时携带 `shareCode`，或携带 `knowledgeBaseId + pageKey` 作为公开上下文。

不能继续仅凭任意 `objectKey` 为匿名请求签发地址。

## 5. 前台信息架构与轻量 UI 调整

### 5.1 保留的视觉资产

- 保留现有 Retypeset 字体、主题色、噪点、装饰线和动效。
- 保留现有桌面固定导航结构和移动端布局基础。
- 保留 `FooterPro`、公开文章正文、目录、思维导图和文章知识图谱。
- 不引入新的 UI 运行时。

### 5.2 首页 `/`

把“按年份归档的文章首页”调整为“知识门户首页”：

1. 顶部增加一段短说明，例如“探索公开文章、语义 Wiki 与知识关系”。
2. 将搜索从导航中的小图标提升为首屏可见的搜索框，同时保留 `⌘/Ctrl + K`。
3. 增加三个轻量入口卡片：
   - 浏览 Wiki
   - 探索关系图谱
   - 向知识库提问
4. 文章区从年份归档改成：
   - 置顶内容
   - 最近更新
5. 文章条目继续复用标题、摘要、阅读时长和标签，不改为厚重卡片墙。

建议文案调整：

- 副标题从 `Knowledge, Articles & Inspiration` 改为更明确的知识门户说明。
- 导航从“文章 / 星图 / 问答”调整为“首页 / Wiki / 关系 / 问答”。
- “文章正在整理中”改为“还没有公开知识内容”。

### 5.3 新增公开路由

```text
/wiki
/wiki/:knowledgeBaseId
/wiki/:knowledgeBaseId/pages/:pageKey
/wiki/:knowledgeBaseId/graph
/search?q=...&mode=hybrid&type=all
```

`pageKey` 写入 URL 时必须编码；服务端查询必须同时使用 `knowledgeBaseId + pageKey`，不能继续只按 `pageKey` 在全站选择第一条记录。

### 5.4 Wiki 页面布局

桌面端：

- 左栏：当前公开知识库的页面目录、类型筛选。
- 中栏：标题、摘要、别名、Markdown 正文。
- 右栏：公开来源文章、相关页面、反向链接。
- 顶部提供“页面 / 图谱”切换和统一搜索入口。

移动端：

- 正文保持单栏。
- 页面目录与来源信息使用抽屉打开。
- 图谱独立全屏展示，避免把三栏强行压缩。

## 6. 公开 Wiki API

新增或调整以下接口：

```text
GET /api/public/wiki/knowledge-bases
GET /api/public/wiki/pages?knowledgeBaseId=...&kind=...&q=...&limit=...&offset=...
GET /api/public/wiki/page?knowledgeBaseId=...&pageKey=...
GET /api/public/wiki/graph?knowledgeBaseId=...
```

### 6.1 `knowledge-bases`

只返回至少包含一个安全公开 Wiki 页面的知识库：

```json
{
  "items": [
    {
      "knowledgeBaseId": "1",
      "name": "示例知识库",
      "description": "...",
      "articleCount": 10,
      "pageCount": 42,
      "updatedAt": "..."
    }
  ]
}
```

### 6.2 `pages`

- 只返回安全公开页面的元数据，不返回正文。
- 支持 `kind`、关键词、分页。
- 默认按 `updated_at DESC, page_key ASC` 排序。
- 返回分类路径、摘要、来源数和更新时间。

### 6.3 `page`

在现有响应上补充：

- `knowledgeBaseId`
- `knowledgeBaseName`
- `categoryPath`
- `updatedAt`
- 安全过滤后的 `links`、`inLinks` 和 `sourceArticles`

页面不存在与页面不公开统一返回 404，避免匿名探测私有页面是否存在。

### 6.4 `graph`

- 直接读取 `petrichor_kb_wiki_page` 与 `petrichor_kb_wiki_link`。
- 节点只包含安全公开 Wiki 页面。
- 边的两端都公开时才返回。
- 复用后台 `buildWikiGraphPayload` 和前台 `SiteGraphExplorer`，不重新开发图谱渲染器。
- 图谱节点双击进入对应公开 Wiki 页面，而不是后台知识空间。
- 页面超过安全渲染上限时，服务端按来源数和连接度选择 500 个节点，并返回 `truncated` 与公开页面总数；目录搜索仍可访问未进入图谱首屏的公开页面。

现有 `/graph` 全站星图继续保留；公开 Wiki 图谱放在具体知识库下，避免混淆“站点运营图谱”和“Wiki 页面关系图谱”。

## 7. 全文与语义搜索统一入口

### 7.1 用户交互

只保留一个搜索入口，但允许切换检索方式：

- 综合：全文 + 语义，默认模式。
- 全文：精确关键词、标题、标签和正文片段。
- 语义：近义词和概念检索。

搜索结果统一显示文章和 Wiki：

```text
[文章] 标题
命中片段…… · 标签 · 更新时间

[Wiki · 概念] 页面标题
命中片段…… · 所属知识库 · 公开来源数
```

交互方式：

- `⌘/Ctrl + K` 打开快速搜索。
- 快速搜索显示前 8～10 条结果。
- “查看全部”进入 `/search`，支持类型、知识库、标签和模式筛选。
- 查询、模式和筛选条件写入 URL，支持复制链接与前进后退。

### 7.2 API

```text
GET /api/public/search
```

请求参数：

```text
q       必填，1～100 字符
mode    hybrid | fulltext | semantic，默认 hybrid；lexical 作为 fulltext 的兼容别名
type    all | article | wiki，默认 all
kb      可选 knowledgeBaseId
limit   默认 20，最大 50
offset  默认 0
```

响应需要包含：

- `items`、`total`、`hasMore`
- `modeRequested`、`modeApplied`
- `semanticAvailable`、`semanticMessage`
- `knowledgeBaseId`、`tag`
- `tookMs`

当 Embedding 模型不可用时，`hybrid` 自动降级为 `lexical`；纯 `semantic` 请求返回明确的可用性错误，不能伪装成语义搜索。

旧 `/api/public/article/search` 保留兼容，复用统一全文召回服务并固定为文章类型。

### 7.3 全文搜索

- 不再直接对整篇 `content_md` 做无界 `ILIKE`。
- 文章使用切片索引的 `search_vector`，标题和标签增加权重。
- Wiki 使用安全公开页面投影的标题、摘要和正文索引。
- 使用 `websearch_to_tsquery('simple', ...)`、`ts_rank_cd`，并保留 `pg_trgm` 处理短词和标题模糊匹配。
- 片段必须从实际命中的公开切片生成。

### 7.4 语义搜索

公开检索直接复用知识构建已经维护的切片与 Wiki 树节点索引，不再复制一份容易滞后的平行数据：

- 文章从 `petrichor_kb_article_chunk_index` 按公开文章 ID 召回。
- Wiki 从 `petrichor_kb_wiki_tree_node` 按安全公开页面 ID 召回。
- 查询按内容所有者分别解析其 `EMBEDDING` 绑定，只在相同模型与维度的向量空间内计算距离。
- 每个所有者内部先聚合到文章或 Wiki 页面，再通过 RRF 合并各空间排名，因此不同供应商的原始距离不会直接比较。
- 分享启用、撤销、设置密码或到期均由查询时的统一公开作用域立即生效，不依赖异步投影清理。
- 知识构建与 Wiki 重编译原本就会更新上述索引，避免额外双写和一致性修复任务。

`hybrid` 使用全文排名与向量排名做 RRF 合并，先按切片召回，再按文章或 Wiki 页面聚合，避免同一长文霸占全部结果。

语义查询增加独立 IP 小时限额、8 秒超时和 10 分钟查询向量缓存；全文搜索不消耗语义配额。

## 8. RSS 与 Atom

### 8.1 路由

提供标准入口：

```text
/rss.xml
/atom.xml
```

同时保留 API 别名便于测试：

```text
/api/public/feed/rss.xml
/api/public/feed/atom.xml
```

需要同步修改：

- Go 路由注册。
- `apps/web/Caddyfile` 的互斥后端 matcher。
- `apps/web/server.ts` 的后端路径判断。
- `apps/web/index.html` 的 `<link rel="alternate">` 发现标签。

修改 Caddy 时继续使用互斥 `handle @backend` 与静态 SPA `handle`，不能让 `try_files` 改写 Feed 路径。

### 8.2 Feed 内容

每种 Feed 返回最近更新的 50 篇安全公开文章：

- `title`
- 使用 `server.base_url` 生成的绝对文章链接
- 稳定 `guid/id`（基于 shareCode）
- `updated_at`
- 公开摘要
- 标签/category
- 作者或站点名称（有可靠来源时才填）

Feed 只放公开摘要，不直接放完整 HTML 或 Markdown 正文，降低附件签名和内容消毒风险。

### 8.3 HTTP 行为

- RSS：`application/rss+xml; charset=utf-8`
- Atom：`application/atom+xml; charset=utf-8`
- XML 字符必须正确转义。
- 增加 `ETag`、`Last-Modified` 和条件请求支持。
- 增加公共缓存头；分享状态变化时清理 Feed 缓存。
- `server.base_url` 必须配置为真实公开地址，不能根据不可信 Host 头拼接链接。
- 没有公开文章时仍返回合法空 Feed，而不是 404。

## 9. 服务端结构建议

### 9.1 统一公开作用域

新建独立包，例如：

```text
apps/api/internal/publicscope/
```

由公开文章、Wiki、图谱、问答、搜索和 Feed 共用，避免 `publicapi -> sitecontent` 的依赖环。该包只负责：

- 公开文章资格判定。
- `articleId -> shareCode/title/knowledgeBaseId/userId` 映射。
- 安全公开 Wiki 页面 ID 集合。
- 可复用 SQL 片段或查询函数。

### 9.2 新增文件建议

```text
apps/api/internal/publicapi/wiki_list.go
apps/api/internal/publicapi/wiki_graph.go
apps/api/internal/publicapi/search.go
apps/api/internal/publicapi/feed.go
apps/api/internal/publicscope/scope.go
apps/web/src/features/pages/public-wiki/
apps/web/src/features/pages/public-search/PublicSearchPage.tsx
apps/web/src/components/blog-search-dialog.tsx
```

### 9.3 数据库索引

本轮不需要新增表或迁移：文章切片索引与 Wiki 树节点索引已经包含 `search_vector`、`embedding`、模型、维度、版本和来源反查字段。公开搜索复用这些结构，并在每次查询时叠加实时公开作用域；这样既保留现有 GIN 全文索引，也避免维护第二份正文和向量。

## 10. 实施记录

### 阶段 0：公开边界加固

- [x] 建立 `publicscope`。
- [x] 修正公开文章列表和旧搜索，排除密码、过期、撤销、禁用分享。
- [x] 修正 Wiki 混合来源与邻居泄露问题。
- [x] 让公开问答和站点图谱复用同一作用域。
- [x] 增加完整可见性矩阵测试。

完成标准：任何匿名列表、搜索、Wiki、图谱和问答都不能命中非公开文章。

### 阶段 1：前台轻量知识门户化

- [x] 调整站点标题、副标题和导航文案。
- [x] 首屏增加统一搜索框与 Wiki/关系/问答入口。
- [x] 文章归档改成“置顶 + 最近更新”。
- [x] 保持 Retypeset 和文章详情页主体不变。
- [x] 完成桌面、平板、移动端检查。

### 阶段 2：公开 Wiki

- [x] 增加知识库列表、Wiki 页面列表和详情 API。
- [x] 公开页面路由使用 `knowledgeBaseId + pageKey` 唯一定位；保留无知识库参数的安全预览兼容接口。
- [x] 完成 `/wiki`、知识库首页和 Wiki 详情页。
- [x] 增加来源文章、相关页面和反向链接。
- [x] 处理空状态、404、下架后的路由行为。

### 阶段 3：公开 Wiki 关系图谱

- [x] 增加安全过滤后的 Wiki graph API。
- [x] 复用现有图谱转换与 `SiteGraphExplorer`。
- [x] 双击节点进入公开 Wiki 页面。
- [x] 增加大图限制、移动端全屏和空状态。

### 阶段 4：统一全文与语义搜索

- [x] 复用文章切片与 Wiki 树节点索引，并按所有者隔离向量空间。
- [x] 完成 fulltext、semantic 和 RRF hybrid 服务。
- [x] 所有查询实时复核公开作用域。
- [x] 改造快捷搜索并增加 `/search` 完整结果页。
- [x] 增加语义限流、超时、缓存和全文降级。
- [x] 兼容旧文章搜索接口。

### 阶段 5：RSS / Atom

- [x] 实现 RSS 2.0 与 Atom 1.0 生成器。
- [x] 增加标准路由、API 别名和 Feed discovery。
- [x] 修改 Caddy 与 Bun 本地代理。
- [x] 增加缓存、ETag、Last-Modified、HEAD 和 XML 测试。
- [x] 更新 README、文档首页和项目介绍页中的 Feed 地址。
- [x] 为纯静态 Demo 生成只包含两篇演示公开文章的 RSS / Atom。

### 阶段 6：联调与验证

- [x] 执行 Go、Web 定向测试和完整检查。
- [x] 用公开、密码、过期、撤销、混合来源数据做越权验证。
- [x] 完成桌面、平板和移动端浏览器验收。
- [x] 验证 Docker/Caddy 下的 Wiki、搜索、RSS 和 Atom。
- [x] 检查搜索延迟、Embedding 可用状态和 Feed 缓存响应头。

## 11. 测试矩阵

### 11.1 服务端

必须覆盖：

1. 永久无密码分享进入全部匿名入口。
2. 密码分享只能通过带密码详情接口读取。
3. 过期、撤销、禁用分享不进入任何匿名索引。
4. Burn 内容不进入普通公开接口。
5. 同时引用公开和私有文章的 Wiki 页面返回 404。
6. 私有 Wiki 邻居不返回标题、摘要和边。
7. 搜索投影滞后时，实时作用域仍能阻断结果。
8. Embedding 不可用时 hybrid 明确降级。
9. RSS、Atom XML 转义、Content-Type、缓存和条件请求正确。
10. Feed 中不出现密码、过期、撤销或禁用文章。

### 11.2 前端

- 快捷搜索 debounce、取消旧请求和键盘导航。
- 搜索模式、类型和知识库筛选同步 URL。
- 文章与 Wiki 结果进入正确路由。
- Wiki 页面来源、出链、反链只显示服务端返回项。
- 图谱节点进入公开路由，不可能进入 `/dashboard/**`。
- 空数据、接口错误、语义降级和图谱截断有明确提示。

### 11.3 验证命令

```bash
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
cd apps/api && go test ./... && go vet ./...
./scripts/check-file-size.sh
```

另外使用浏览器检查至少以下视口：

- 1440 × 900
- 1024 × 768
- 390 × 844

## 12. 最终验收标准

- 首页视觉仍属于现有 Petrichor，但第一印象不再是年份归档博客。
- 未登录用户可以从首页进入 Wiki，阅读公开 Wiki 页面并探索关系图谱。
- 一个搜索框可以检索公开文章与 Wiki，并明确支持全文、语义、综合三种模式。
- 密码、过期、撤销、禁用和 Burn 内容不会出现在首页、Wiki、图谱、搜索、问答或 Feed。
- 混合公开/私有来源的 Wiki 页面不会被匿名读取。
- `/rss.xml` 与 `/atom.xml` 能被常见 Feed 阅读器订阅。
- Docker/Caddy 与本地 Bun 源码启动方式下行为一致。
