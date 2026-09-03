![知识可移植性](./assets/covers/knowledge-portability.png)

# 知识可移植性：OKF 导出、编译说明书与 Skill 包

Petrichor 把源文档编译成 Wiki 之后，这一层知识不应该只锁在数据库里。
本文档说明三个把它交出去的出口，以及一个控制它怎么被编译出来的入口。

所有端点都在已登录用户态（`/api/kb/*`），只能操作自己名下的知识库。

## 1. 导出成 OKF bundle

`POST /api/kb/wiki/export`

```jsonc
{ "knowledgeBaseId": "1", "format": "okf" }  // format: okf（默认）| obsidian
```

返回 zip 附件。产物遵循 Google [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) v0.2：

```text
index.md          bundle 清单，frontmatter 只声明 okf_version
log.md            Wiki 变更时间线（OKF 保留文件名，不带 frontmatter）
sources/*.md      源文档页面
concepts/*.md     概念页面
entities/*.md     实体页面
comparisons/*.md  对比页面
answers/*.md      问答页面
guides/*.md       编译说明书等 meta 页面
```

每个概念文件的 frontmatter 由页面数据推导，不额外落库：

| 字段 | 来源 |
| --- | --- |
| `type` | 页面 `kind`（source → Source Document，concept → Concept …） |
| `title` / `description` | 页面标题与摘要 |
| `tags` | frontmatter 里的分类路径与别名 |
| `status` | 有来源引用为 `stable`，没有为 `draft`，归档为 `deprecated` |
| `stale_after` | 源文档在这页编译之后的最新更新时间；早于当前时间即表示已过时 |
| `generated` | 构建流程与页面更新时间 |
| `sources` | 来源引用指回的源文章 URL、标题与最后修改时间 |
| `x_petrichor` | Petrichor 私有扩展：page key、kind、版本、内容指纹 |

两种格式的差别只在正文链接：`okf` 把 `[[page-key|标签]]` 改写成 bundle 绝对路径的标准
Markdown 链接；`obsidian` 原样保留 wikilink，解压后可直接当 Obsidian vault 打开。
解析不到的 page key 一律保持原样，断链信息交给结构检查暴露，导出阶段不静默吞掉。

实现见 `apps/api/internal/kb/okf.go` 与 `wiki-export.go`。

## 2. 蒸馏成 Agent Skill 包

`POST /api/kb/wiki/skill-pack`

```jsonc
{ "knowledgeBaseId": "1", "includeSources": false }
```

返回 zip 附件，解压后放进 Claude Code / Codex 的 skills 目录即可使用：

```text
<slug>/SKILL.md              name + description 头、领域说明、用法、目录、在线检索入口
<slug>/references/index.md   全部入包页面清单
<slug>/references/**/*.md    按引用度精选的页面正文（带 OKF frontmatter）
```

和外部接入用的 `/api/agent/skill` 不同：前者说明「怎么调 Petrichor 的 API」，这里装的是知识本身。
`/api/agent/skill-pack` 只是可选的自定义目录打包器；未配置 `[agent].skills_directory` 时返回 404。

选页策略：编译说明书必选；其余按入链数降序、同分按标题排序，受页数（60）与
正文字节（2 MiB）双重约束；源文档页默认不收，`includeSources: true` 时才带上。
`SKILL.md` 的 `description` 会带上入链最多的若干页面标题作为触发词。

实现见 `apps/api/internal/kb/wiki-skillpack.go`。

## 3. 编译说明书

`POST /api/kb/wiki/guide` 读取，`POST /api/kb/wiki/guide/save` 保存（`contentMd` 为空即停用）。

说明书是一页 `kind = "meta"` 的 Wiki 页面（page key 固定 `compile-guide`），
保存后会追加到这个知识库**每一次**编译的 system prompt 末尾，用来细化
「抽什么、怎么归类、页面怎么写」。它只能细化领域偏好，不能改变输出格式：
提示词里明确声明冲突时以系统格式为准。

注入前会做两步清洗，所以模板里的示例不会被当成规则：

- 剥掉 HTML 注释；
- 丢掉只有标题、没有内容的小节。

没保存过的知识库注入空内容，编译行为与从前逐字一致。「完全重建」会清空全部
编译产物，但保留这一页——它是用户手写的配置，不是编译产物。

生效范围是**之后的编译**；要让已有页面套用新约定，保存后再执行一次
「更新 Wiki」或「完全重建」。

实现见 `apps/api/internal/kb/wiki-guide.go`。

## 4. 知识新鲜度

结构检查（`POST /api/kb/wiki/lint`）除结构问题外，还会报两类需要重新编译的信号：

| code | 严重级 | 含义 |
| --- | --- | --- |
| `stale_source` | warning | 页面引用的源文档在这页编译之后改过 |
| `outdated_build` | info | 页面由更老的编译流程或分片算法产出 |

判定优先用精确指纹：source 页面的 frontmatter 存了编译当时的 `sourceHash`，
与源文章当前内容重新哈希后比对即可确定文章是否变过；概念、实体等派生页面
沿用它们所引用文章的结论。只有当某篇文章根本没有 source 页面（存量数据）时，
才退回「文章更新时间晚于页面更新时间」的近似比较——所以改标签之类不动正文的
编辑不会误报。

响应里的 `stalePageCount` 是至少命中一条失效原因的页面数，导出时同一判定会写进
每页的 `stale_after`。

实现见 `apps/api/internal/kb/wiki-freshness.go`。
