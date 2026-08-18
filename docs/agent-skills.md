# Agent Skills

Skill = 一组工具 + 一段操作说明。它是**动态能力**，不是意图分类结果。

- 默认只把简短能力目录写进 system prompt（一行描述）；
- 完整 instructions 只在 `load_skill` 之后注入；
- 加载 Skill 只扩大模型可见能力，不改变用户真实权限。

## 内置 Skill

| id | 说明 | 主要工具 |
| --- | --- | --- |
| `knowledge` | 站内知识库检索与深读 | `knowledge.search` / `knowledge.read` |
| `graph` | 实体关系与关联文章（依赖 knowledge） | `graph.*` |
| `research` | 站外公开资料检索与阅读 | `research.search` / `fetch` / `extract` |
| `memory` | 跨会话长期记忆 | `memory.search` / `memory.write` |
| `writer` | 长文撰写与改写 | `writer.*` |
| `documents` | 文档检索、阅读与增改导出 | `document.*` |
| `admin` | 模型配置、API Key、站点开关 | `admin.*` |
| `system` | 站点概览与计数 | `system.overview` |

## 新增 Skill

```ts
agentSkillRegistry.register({
    id: "research",
    name: "外部研究",
    description: "搜索与阅读站外公开资料",   // 目录里只出现这一行
    instructions: RESEARCH_SKILL_PROMPT,      // 放在 prompts/skills.ts
    toolIds: ["research.search", "research.fetch", "research.extract"],
    dependencies: ["knowledge"],              // 依赖会先加载
    permissions: ["assistant.write"],
})
```

约束：

- `instructions` 写在 `agent-runtime/prompts/` 下，不要嵌在业务逻辑文件里；
- `toolIds` 里未注册的工具会在启动时被自动裁掉（`tools/index.ts`），避免暴露空能力；
- 一个工具都用不了的 Skill 不允许加载。

## 加载语义

```text
load_skill("research")
  → 依赖优先加载（knowledge → research）
  → 权限校验（不通过则拒绝，不静默降级）
  → instructions 注入下一段上下文
  → 工具解锁
  → Trace + skill_loaded 事件
  → 不重复加载
```

加载成功后 Runtime 会**立即结束当前推理段**，用扩展后的工具集重开一段。
这是为了让新工具真正对模型可见——同一段里 `activeTools` 是固定的。

Router 无权阻止任何 Skill 加载：即使意图只识别到 knowledge，
Agent 依然可以自行 `load_skill("research")`。
