---
doc_type: feature-ff-note
slug: public-ask-restore
created: 2026-07-11
status: done
---

# 恢复前台公开问答 `/ask`

## 做了什么

从 `0e74e59` 前版本恢复公开问答闭环，并重新接线：

- API：`POST /api/public/qa/chat`
- 逻辑：`public-qa-logic` / `public-qa-handlers` / `public-qa-rate-limit`
- 前台：`/ask` 页 + Tool UI；站点导航「问答」入口
- 超管开关：`SiteAppearanceConfigPage` 的 `publicQaEnabled`

## 权限与可见性硬边界

1. 站点开关 `petrichor_site_appearance.public_qa_enabled=false` → 403
2. 仅索引**永久分享且 listed、未过期、无密码**的文章（`petrichor_kb_article_share`）；阅后即焚不入索引
3. SQL 层 `publicShareVisibilitySql` + 应用层 `resolvePublicHomepageShareStatus` 双保险
4. 读工具全部经 `PublicArticleScope` 校验；非公开 articleId / nodeKey / pageKey → 404/400
5. 工具集只读：无写入 / 管理 / 删除类工具
6. 模型用站长（首个 SUPER_ADMIN）默认 CHAT 配置，不暴露用户私有知识库工具
7. 访客限流：visitor 10/h + IP 60/h；请求 `credentials: "omit"`

## 验证

- Vitest：public-qa-logic（含密码/过期过滤）/ rate-limit / public-theme-routes / appearance.logic
- `tsc` 通过
