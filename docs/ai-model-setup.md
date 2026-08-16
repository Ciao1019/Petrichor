# AI 模型接入

## 数据模型

模型接入分四层，替代原先的单表 `petrichor_ai_model_config`：

| 表 | 职责 |
| --- | --- |
| `petrichor_ai_credential` | API Key 凭证库，一条凭证可被多个供应商实例复用 |
| `petrichor_ai_provider` | 供应商实例 = 目录里的某个供应商 + 一条凭证 + 可覆盖的 BaseUrl |
| `petrichor_ai_model` | 该供应商下已启用的模型，由「获取模型列表」写入 |
| `petrichor_ai_binding` | 用途绑定：CHAT / VISION / DOC_QA / EMBEDDING 各绑一个模型 |

业务代码只说「我要 CHAT 模型」，由 `server/ai/resolution.ts` 查出绑定 → 供应商 → 凭证，
拼成 `ProviderRuntimeConfig` 交给 `server/ai/model-factory.ts` 实例化。换模型无需改代码。

## 配置流程

对应「模型配置」页的三个 Tab：

1. **凭证**：录入 API Key。一条凭证可被多个供应商复用，轮换只改一处。
   Bedrock / Vertex / Azure 这类需要额外字段（AK/SK、服务账号、资源名）的供应商，
   要在凭证里先选定供应商才会出现对应输入框。
2. **供应商**：从内置目录选一个供应商，默认 BaseUrl 会自动带出（可改成代理地址），
   选一条凭证后即可「测试连通」。保存后点「管理模型」拉取该供应商的 `/models`，
   勾选要启用的模型；拉不到时回退到内置模型清单。
3. **用途绑定**：把模型绑到四个用途上，并按用途设置 maxTokens、temperature、思考模式。

供应商目录定义在 `apps/web/src/server/ai/provider-catalog.ts`，新增一家只需要加一条记录：
有官方 `@ai-sdk/*` 包的填对应 `sdk`，没有的填 `openai-compatible` 并给上默认 BaseUrl。

## 接口协议：chat completions 与 responses

语言模型有两套 HTTP 协议：

- `chat` → `POST {baseUrl}/chat/completions`
- `responses` → `POST {baseUrl}/responses`

**这个选择必须显式声明，不能依赖 SDK 默认值。** `@ai-sdk/openai` v4 起
`provider.languageModel(id)` 返回的是 Responses 模型，`azure` 和 `xai` 同理。
而绝大多数「OpenAI 兼容」的中转网关、私有部署和本地推理服务（one-api、new-api、
Ollama、LM Studio 等）只实现了 `/chat/completions`，用 SDK 默认值会直接 404。

因此：

- 目录里用 `apiProtocols` 声明该供应商支持哪几套，**第一项是默认值，一律为 `chat`**；
- 只有 OpenAI / Azure OpenAI / xAI 声明了两套，界面上才出现「接口协议」选择器；
- 用户的选择存在 `petrichor_ai_provider.options_json.apiProtocol`，
  由 `providerApiProtocol()` 读出，`resolveApiProtocol()` 对非法值和不支持的组合回落到默认值；
- `model-factory.ts` 据此显式取 `provider.chat(id)` 或 `provider.responses(id)`，
  不走 `provider.languageModel(id)`；
- 「测试连通」会带上表单里当前选的协议，避免「测试通过、实际调用 404」。

其余供应商只有一套协议（Anthropic 的 `/v1/messages`、Gemini 原生接口、Bedrock 的 SigV4、
以及各家 OpenAI 兼容端点的 `/chat/completions`），走 SDK 统一入口即可。

供应商怪癖修正（`provider-quirks.ts`，DeepSeek 的 json_schema 降级和 thinking 注入）
两套端点都会拦截——只匹配 `/chat/completions` 的话，换协议后修正会静默失效。

## 向量维度

维度不写死，由模型决定。

**模型侧**：绑定「向量嵌入」用途或在模型列表里点探测时，会发一次极短的 embed 请求
量出真实长度，写入 `petrichor_ai_model.dimensions`；真正 embed 时若发现实际长度
与记录不符（供应商同名换了实现），以实际为准自愈更新。

**存储侧**：向量列是无约束的 `vector`，不同维度的行可以共存。
索引采用**每维度一条部分表达式索引**：

```sql
create index ... using hnsw ((embedding::vector(N)) vector_cosine_ops)
where vector_dims(embedding) = N
```

新维度首次出现时由 `persistDimensions` 自动创建（见 `server/retrieval/vector-space.ts`）。
查询侧必须带上 `vector_dims(embedding) = N` 过滤并对列做同样的转型才能命中该索引——
跨维度做 `<=>` 本来就会被 pgvector 拒绝，所以这个过滤是硬性要求而不是优化。

因此**换向量模型不需要清空数据**：旧维度的向量原样保留，只是会被判定为待重算。

维度超过 2000 时 pgvector 建不了 HNSW，检索退化为顺序扫描（功能仍正确，只是变慢）。
探测接口会在响应里返回 `indexable: false` 和一条说明。

### 新鲜度判定：为什么只看维度不够

维度相同不代表向量空间相同。两个都输出 1024 维的模型互换后，`vector_dims` 过滤
挡不住旧向量，检索会静默返回错误结果。所以有重算流程的表要比对三元组：

- `embedding_model` —— 哪个模型写的
- `embedding_dimensions` —— 实际维度
- `embedding_version` —— 分块/归一化策略版本（`EMBEDDING_VERSION`，改策略时 +1）

三者任一对不上就算待重算。目前只有 `petrichor_kb_wiki_tree_node` 带这套元数据，
它是唯一有「补写 / 重算」流程的表。`petrichor_assistant_message_embedding` 是滚动的
会话缓存，按维度过滤即可，过期条目自然淘汰；`petrichor_agent_memory.embedding`
当前没有读写方。

## 迁移

按顺序执行：

```text
docs/migrations/2026-08-15-rebuild-ai-model-config.sql
docs/migrations/2026-08-16-dynamic-embedding-dimensions.sql
```

第一个会 **删除** `petrichor_ai_model_config` 且不迁移存量数据，执行后需要在「模型配置」页重新接入。
同时会把 `petrichor_assistant_run` / `petrichor_kb_import_job` / `petrichor_ai_review` 上的
`model_config_id` 清空——这三列语义已改为指向 `petrichor_ai_model.id`，旧值是悬空引用。

第二个把三张表的向量列放宽为无约束 `vector`，拆掉钉死维度的旧 HNSW 索引并按
新形式重建 1024 维那条，再给 `petrichor_kb_wiki_tree_node` 加上生命周期元数据列。
存量向量原样保留，`embedding_model` 有意留空——我们无从得知它们是哪个模型写的，
留空会让它们在下次绑定模型后被判定为待重算。这是保守但正确的行为：
宁可重算，不要拿来源不明的向量做检索。

全新库不用跑这两个脚本，`full-migration.ts` 里已经是最终形态。
执行前请确认已备份，并确认连接的是目标库。
