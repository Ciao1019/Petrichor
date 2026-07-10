---
doc_type: feature-design
feature: 2026-07-10-agent-context-vector-recall
requirement: chat-first-universal-agent
roadmap: assistant-runtime-depth
roadmap_item: agent-context-vector-recall
status: approved
summary: 对线程较早消息做 embedding，按当前用户问题向量召回相关片段注入 ContextPack.recalledSnippets；无配置/SQLite 静默跳过
tags: [agent, assistant, context, vector, recall]
---

# agent-context-vector-recall design

## 0. 术语约定

| 术语 | 定义 | 防冲突结论 |
|------|------|-----------|
| recalledSnippets | ContextPack 可选字段：相关历史片段 | 契约 4.3 |
| message embedding 表 | `petrichor_assistant_message_embedding` | 独立表，不改 message 行结构 |
| fail-open 召回 | 无 EMBEDDING / SQLite / 出错 → 空数组，不阻断 | 与 wiki best-effort 一致 |

## 1. 决策与约束

**需求**：长对话在摘要之外，按当前问题召回较早相关原文片段。

**默认**：
1. 独立表 + pgvector(1024)；索引在 buildContextPack 内 best-effort 补齐（每轮最多一批）
2. 查询 = 本轮最后一条用户文本；排除最近窗口 message id；topK=4，相似度门槛约 0.25
3. 注入 instructions，不伪造气泡；excerpt 过滤密钥/确认明文
4. 无配置或 SQLite → 跳过

**不做**：跨线程召回；改 TokenLimiter；新 HTTP；强制用户配置 embedding。

## 2. 名词与编排

### 2.1 名词层

```
recalledSnippets?: { messageId, score, excerpt }[]
ensure + recallRelevantHistory → snippets
buildInstructions(..., summary, snippets)
```

### 2.2 编排层

buildContextPack → 窗口切分 →（可选）补 embedding → 召回 → 返回 pack

### 2.3 挂载点

1. 迁移表 + full-migration  
2. `context-recall.ts`  
3. ContextPack / instructions 接线  

### 2.4 / 2.5

新文件承载；不做目录重组。

## 3. 验收

1. 无 embedding 配置 → pack 无召回、对话正常  
2. 有配置 + 较早消息 → 可召回相关 excerpt  
3. 最近窗口内消息不出现在召回  
4. 注入在 instructions，不进 recentMessages  
5. SQLite / 抛错 fail-open  

## 4. 架构

更新 runtime-assistant：向量历史召回一句。
