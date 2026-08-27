# Agent Tools

所有 Agent 可用工具必须注册到 Go Runtime 的 `DefaultToolRegistry`，
并且只能经 `ToolExecutor` 执行。不存在绕过执行器的调用路径。

## 能力清单

| namespace | 工具 |
| --- | --- |
| `knowledge` | `search` / `read` / `list_bases` |
| `graph` | `search` / `expand` / `get_entity` / `get_relations` |
| `research` | `search` / `fetch` / `extract` |
| `memory` | `search` / `write` / `update` / `delete` |
| `writer` | `compose` / `rewrite` / `summarize` / `structure` / `save_artifact` |
| `document` | `search` / `read` / `create` / `update` / `move` / `share` / `preview_update` / `export` / `list_libraries` |
| `admin` | `list_models` / `bind_model` / `list_api_keys` / `get_public_qa` |
| `system` | `overview` / `show_citations` / `show_data_table` / `show_progress` |
| `agent` | `load_skill` / `delegate` / `update_plan` / `request_confirmation` |

`writer.*` 会把本轮已收集的 Evidence 作为事实基座调用一次独立生成，
因此长文写作不占用主循环上下文，正文事实也可追溯到证据。

## Namespace

```text
knowledge.*  research.*  memory.*  graph.*
writer.*     document.*  admin.*   system.*   agent.*
```

对模型暴露的名字保持与旧工具兼容（例如 `knowledge.search` 的公开名仍是 `search_knowledge`），
Registry 内部则统一用带 namespace 的 id。

## 核心工具

Main Agent 默认只看到少量核心工具，其余靠 `load_skill` 解锁：

```text
agent.load_skill      agent.delegate      agent.update_plan
knowledge.search      knowledge.read      system.overview
```

## 新增一个工具

1. 在 `apps/api/internal/assistantsvc/` 对应领域文件中实现执行体。
2. 创建 `runtime.AgentToolDefinition`，明确 id、模型可见名称、namespace、风险级别、
   副作用、子代理权限、输入 Schema、执行函数和标准化函数。
3. 在 `RegisterAssistantTools` 调用链中注册工具；危险写操作必须复用确认票据包装。
4. 标准化函数把原始结果转成**紧凑观察 + 结构化证据**。
   原始结果只进 Trace，不进 LLM Context。
5. 把 id 加进对应 Skill 的工具列表并补充契约测试。

## 描述规范

工具描述必须写清四件事，且不同工具之间不能高度相似：

```text
何时用 / 输入是什么 / 输出是什么 / 何时不要用
```

## Side Effect Policy

`create / update / delete / publish / send / share / 权限变更 / 外部写入`
一律 `sideEffect: true`；高风险的再加 `requiresConfirmation: true`。
Search / Read 默认 `sideEffect: false`。

## 权限

`DefaultPermissionResolver` 统一裁决：

- 子代理只能用被显式授权、且 `allowedInSubAgent !== false` 的工具；
- `requiresOperator` 的工具对非操作员完全不可见；
- 加载 Skill 只扩大「模型可见能力」，不改变用户真实权限。
