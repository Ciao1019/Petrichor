---
doc_type: issue-fix
feature: assistant-usage-timing-ui
date: 2026-07-16
severity: P2
tags: [assistant, usage, timing, ui]
status: fixed
---

## 现象
右下角上下文占用一直 `0 (0%)`；消息底部悬停看不到耗时 / tok/s。

## 根因
1. Mastra `toAISdkStream` v6 把 finish 上的 `totalUsage` 剥掉，且落库只存 `parts`，usage 从未进入消息 metadata。
2. `@assistant-ui` converter 用 WeakMap 按 message 对象缓存；客户端 `useStreamingTiming` 在流结束后才写入 timing，消息身份不变导致 `metadata.timing` 装不上。

## 修复
- `chat-handler.ts`：`messageMetadata` 注入 `custom.usage`；`onEnd` 持久化 usage + totalStreamTime（及 tokensPerSecond）。
- `MessageTimingDisplay`：组件内自算 timing，绕过 converter 缓存；`readPersistedTiming` 兼容 `metadata.timing`。
- `ComposerContextBar` 改用 `useThreadTokenUsage`。

## 验证
- `usage-meta.test.ts` / `assistant-message-utils.test.ts` 通过。
- 需在浏览器：新对话结束后看右下角占用变化；悬停消息底部 action bar 出现耗时。
