# assistant-runtime-depth — 怎么推进

## 默认技术序

1. `agent-plan-persist`（最小闭环）
2. `agent-context-window-v2`
3. `agent-resilience-playbook`（可与 2 并行）
4. `agent-context-vector-recall`
5. `agent-subagent-depth-limit`
6. `agent-subagent-write`
7. `agent-multi-agent-fanout`

## 开一条

```text
按 cs-feat-design，从 roadmap 起头做 assistant-runtime-depth 里的 {SLUG}。
硬约束：读 attention.md；读本 roadmap 第 3、4 节与 items.yaml；
frontmatter 带 roadmap: assistant-runtime-depth 与 roadmap_item: {SLUG}。
本轮只产出 design + checklist，等确认后再实现。
```

## 产品线优先（可选）

若只想先打一条线：

- **计划体验** → 只开 `agent-plan-persist`（+ 可选 resilience）
- **长对话质量** → `context-window-v2` → `vector-recall`
- **子代理能力** → `depth-limit` → `write` → `fanout`（建议 window-v2 已完成）
