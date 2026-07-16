---
doc_type: audit-index
audit: 2026-07-16-runtime-assistant
scope: Assistant 运行时（server/assistant、api/assistant、features/pages/assistant）对照 runtime-assistant.md；含优化发现与新功能候选
created: 2026-07-16
status: active
total_findings: 21
---

# runtime-assistant 审计报告

## 范围

- `apps/web/src/server/assistant/**`
- `apps/web/app/api/assistant/**`
- `apps/web/src/features/pages/assistant/**`
- 对照：`.codestable/architecture/runtime-assistant.md`、roadmap 观察项
- 维度：bug / security / performance / maintainability / arch-drift（各 ≤5）
- 另附：新功能候选（非 finding，供产品拍板）

## 总评

共 **21** 条发现。最严重是确认协议完全信任客户端 messages（P0）：可伪造 `confirmed` 执行危险工具，且无服务端一次性消费。性能上 SSE 首 token 前串行阻塞、embedding 热路径补齐、消息全量加载会直接拖慢长对话。可维护性上壳与 handler 已成巨石，子代理实现重复。架构上 dangerous 装载过滤与超管校验本身符合文档；偏离点是意图路由可一次装上全部写域。

## 发现清单

| # | 性质 | 严重度 | 置信度 | 标题 | 文件 |
|---|---|---|---|---|---|
| 1 | security | P0 | high | 确认态可客户端伪造，绕过确认协议 | [finding-01.md](finding-01.md) |
| 2 | security | P1 | high | 确认无服务端一次性消费，可重放 | [finding-02.md](finding-02.md) |
| 3 | security | P1 | high | 确认执行路径把 API Key 明文写入 steps | [finding-03.md](finding-03.md) |
| 4 | bug | P1 | high | 确认续跑时可能把 assistant 消息当 user 持久化 | [finding-04.md](finding-04.md) |
| 5 | bug | P1 | high | delete_article 多表删除无事务 | [finding-05.md](finding-05.md) |
| 6 | bug | P1 | medium | 并发确认请求可重复执行危险动作 | [finding-06.md](finding-06.md) |
| 7 | bug | P2 | medium | afterToolCall 固定 input:{} 且 stepIndex 非原子 | [finding-07.md](finding-07.md) |
| 8 | bug | P2 | medium | parseAssistantFocus 无 schema 校验的类型断言 | [finding-08.md](finding-08.md) |
| 9 | arch-drift | P1 | high | 意图路由无域数量上限，可一次装载全站非 dangerous 工具 | [finding-09.md](finding-09.md) |
| 10 | arch-drift | P2 | medium | DANGEROUS_ACTION_WHITELIST 含未实现逻辑名 | [finding-10.md](finding-10.md) |
| 11 | arch-drift | P2 | low | public_qa.disable 映射名与可 enable 行为不一致 | [finding-11.md](finding-11.md) |
| 12 | performance | P1 | high | SSE 开流后首 token 前串行阻塞过久 | [finding-12.md](finding-12.md) |
| 13 | performance | P1 | high | 同轮重复执行 context 压缩探测与打包 | [finding-13.md](finding-13.md) |
| 14 | performance | P1 | high | 向量召回在对话热路径同步补 embedding | [finding-14.md](finding-14.md) |
| 15 | performance | P1 | high | 线程详情与水位计算无分页全量加载消息 | [finding-15.md](finding-15.md) |
| 16 | performance | P1 | high | Fanout×子代理成本叠加且超时不取消底层任务 | [finding-16.md](finding-16.md) |
| 17 | maintainability | P1 | high | AssistantChatPage 巨石模块（~2785 行） | [finding-17.md](finding-17.md) |
| 18 | maintainability | P1 | high | assistantChat 上帝函数职责过重 | [finding-18.md](finding-18.md) |
| 19 | maintainability | P1 | high | research / write 子代理实现大块重复 | [finding-19.md](finding-19.md) |
| 20 | maintainability | P2 | high | 消息明文抽取逻辑双份拷贝 | [finding-20.md](finding-20.md) |
| 21 | maintainability | P2 | medium | 预算常量与工具黑名单散落 | [finding-21.md](finding-21.md) |

## 按维度分布

| 性质 | P0 | P1 | P2 | 合计 |
|---|---|---|---|---|
| bug | 0 | 3 | 2 | 5 |
| security | 1 | 2 | 0 | 3 |
| performance | 0 | 5 | 0 | 5 |
| maintainability | 0 | 3 | 2 | 5 |
| arch-drift | 0 | 1 | 2 | 3 |
| **合计** | **1** | **14** | **6** | **21** |

## 已核对且符合架构（未记为发现）

- `loadMastraToolsForDomains` 跳过 `risk=dangerous`，不对模型暴露
- `set_public_qa_enabled` 执行路径有超管校验
- AI 配置 / Agent Key 按 `userId` 归属
- assistant 树内无 `propose_wiki_patch`、无改动 `/api/agent/**`
- 默认只读三域为 `system/knowledge/doc_library`
- 跨会话记忆蒸馏保持 cancelled（不作为缺口强推）

## 新功能候选（产品向）

来自 roadmap 观察项、架构「明确不做」与愿景残留；**需另开 roadmap/feature，本审计不定修**。

| 优先级建议 | 候选 | 依据 | 备注 |
|---|---|---|---|
| 高 | **对话可观测性（Langfuse / run·step tracing UI）** | roadmap 观察项 | 韧性已有字段，缺产品面 |
| 高 | **长线程消息分页 + 冷启动增量 hydrate** | finding-15 | 既是优化也是产品能力 |
| 中 | **旧 KB/Doc 会话只读归档浏览** | roadmap §7 未定 | 表未 DROP，缺入口 |
| 中 | **文档库向量检索对齐知识库** | roadmap §7 | 只读体验门闩外能力 |
| 中 | **对话内创建 AI 配置 / Agent Key** | 架构明确暂不做 | 仍走管理页；若要「一个入口办事」可补 |
| 中 | **危险确认服务端票据（nonce + 一次性消费）** | finding-01/02 | 安全修复同时可产品化为确认协议 v2 |
| 低 | **重开公开 `/ask`** | roadmap §7；attention 仍记 `/ask` | 与站内壳分离，另开 feature |
| 低 | **多 Agent 团队 DSL** | depth roadmap 明确不做 | 仅当 fanout 不够用再开 |
| 不做（除非改愿景） | 跨会话记忆蒸馏 | `agent-memory-runtime` cancelled | 用户已拍板下线 |

## 下一步建议

- **P0 立刻修**：finding-01（确认态服务端绑定）→ 开 `cs-issue`
- **同批 P1 安全/正确性**：finding-02 / 03 / 04 / 05 / 06 / 09
- **体验迭代**：finding-12 / 13 / 14 / 15 / 16（TTFB、embedding、分页、取消）
- **结构债**：finding-17 / 18 / 19 → `cs-refactor`
- **新功能**：先从「可观测性」或「消息分页」开 `cs-roadmap` / `cs-feat`；记忆勿默认重启

选定任一条后走 `cs-issue`（修 bug/安全）或 `cs-refactor`（结构优化）或 `cs-feat`（新功能）。
