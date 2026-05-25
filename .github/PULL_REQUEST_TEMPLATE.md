<!--
感谢提交 PR！请确认下方信息后再发起。
- 中文 / 英文均可
- 删除不适用的小节
-->

## 改动说明 / Summary

<!-- 用 1–3 句话说明本 PR 做了什么、动机是什么 -->

## 关联 Issue / Related issues

<!-- 用 `Closes #123` 自动关闭 Issue；或 `Refs #123` 仅引用 -->

Closes #

## 改动类型 / Type of change

- [ ] 🐞 Bug 修复 (fix)
- [ ] ✨ 新功能 (feat)
- [ ] ♻️ 重构 (refactor) — 无功能变化
- [ ] 📝 文档 (docs)
- [ ] ✅ 测试 (test)
- [ ] 🎨 UI / 样式
- [ ] 🔧 构建 / 工具链 / 依赖 (chore)
- [ ] ⚠️ 破坏性变更 (BREAKING CHANGE)

## 变更范围 / Scope

<!-- 勾选受影响的模块 -->

- [ ] 富文本编辑器 (PlateJS)
- [ ] 知识库 / 文章
- [ ] AI 助手 / AI 回顾
- [ ] 认证 / 账号 / OAuth
- [ ] 上传 / 对象存储
- [ ] 仪表盘 / 统计
- [ ] 公开站点 / RSS / SEO
- [ ] 主题 / 外观
- [ ] 通知
- [ ] 数据库 schema / 迁移
- [ ] 部署 / 配置 / CI
- [ ] 文档

## 数据库迁移 / Database migration

<!-- 如有 schema 变更，勾选并填写迁移文件名 -->

- [ ] 本 PR 包含 schema 变更
- [ ] 已在 `docs/migrations/` 添加增量 SQL 文件
- [ ] 已在 `apps/web/src/server/db/schema.ts` 同步更新
- [ ] 已验证 `pnpm --silent --filter @petrichor/web db:sql` 生成的 SQL 在新库可一次性执行

迁移文件： `docs/migrations/____.sql`

## 验证 / How to test

<!-- 重要！描述如何复现你的验证步骤，让 reviewer 能跑一遍 -->

```bash
# 例如
pnpm dev
# 然后访问 /xxx，执行 …
```

完整验证：

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm lint` 通过
- [ ] `pnpm test` 通过
- [ ] `pnpm build` 通过（涉及路由 / 构建产物时）
- [ ] 桌面浏览器人工验证
- [ ] 移动视口人工验证（如涉及 UI）

## 截图 / Screenshots

<!-- UI 变更必填：前后对比截图 / 录屏 -->

| Before | After |
| --- | --- |
|        |       |

## 检查清单 / Checklist

- [ ] 我已阅读 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 和 [`AGENTS.md`](../AGENTS.md)
- [ ] PR 标题遵循 Conventional Commits（如 `feat(kb): 新增文章拖拽排序`）
- [ ] 单 PR 只做一件事；改动范围最小且完整
- [ ] 没有提交 `.env.local`、密钥、Token 等敏感信息
- [ ] 没有提交无关的 `pnpm-lock.yaml` 变更
- [ ] 注释 / 文档已同步更新（如有必要）
- [ ] 不引入未接线的"半成品"功能或 TODO 占位

## 其他补充 / Notes

<!-- 任何 reviewer 需要知道的信息：性能影响、安全注意事项、兼容性等 -->
