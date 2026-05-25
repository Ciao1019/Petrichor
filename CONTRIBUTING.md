# 贡献指南 · Contributing to Petrichor

感谢有兴趣为 **Petrichor** 做出贡献！本文档说明了提交 Issue、Pull Request 的流程，以及代码风格、本地验证等约定。

> 中文为主要协作语言；英文 PR / Issue 同样欢迎。

---

## 📑 目录

- [行为准则](#行为准则)
- [提 Issue](#提-issue)
- [提 Pull Request](#提-pull-request)
- [本地开发环境](#本地开发环境)
- [代码风格](#代码风格)
- [Commit 规范](#commit-规范)
- [验证清单](#验证清单)
- [安全漏洞报告](#安全漏洞报告)

---

## 行为准则

请保持友善、尊重和耐心。我们欢迎不同水平、不同背景的贡献者。

- 不发布攻击性、歧视性或骚扰性言论
- 对事不对人，针对代码和方案讨论
- 接受不同意见，并以建设性方式表达自己的观点

---

## 提 Issue

在 [Issues](https://github.com/LittleBunVerse/Dosphere-vercel/issues) 中提交问题前：

1. **先搜索** 是否已有相同 / 类似 Issue。
2. 选择合适的模板：
   - 🐞 **Bug 报告**：用于报告异常行为
   - ✨ **功能建议**：用于提议新功能或增强
3. 按模板提示填写完整信息，**复现步骤 / 期望行为 / 实际行为 / 环境** 都必填。
4. 如附带截图或日志，请隐去敏感信息（数据库密码、API Key、Cookie、用户邮箱等）。

> 不确定是 Bug 还是用法问题？欢迎在 **Discussions** 提问，避免开 Issue。

---

## 提 Pull Request

### 工作流

```
1. Fork 仓库  →  2. 新建分支  →  3. 提交改动  →  4. 本地验证  →  5. 推送并提 PR
```

具体步骤：

```bash
# 1. Fork 后克隆
git clone https://github.com/<你的用户名>/Dosphere-vercel.git petrichor
cd petrichor

# 2. 新建分支（不要在 main 上直接改）
git checkout -b feat/your-feature-name
# 或修复类： fix/short-description
# 或文档类： docs/update-readme

# 3. 改动 + 提交（见下方 Commit 规范）
# 4. 跑完整验证（见下方验证清单）

# 5. 推送并通过 GitHub UI 提交 PR
git push origin feat/your-feature-name
```

### PR 要求

- ✅ **PR 描述**：按 [`PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) 填写改动说明、关联 Issue、验证方式
- ✅ **小而完整**：单个 PR 聚焦一件事，避免把多个无关变更打包提交
- ✅ **不修改 `pnpm-lock.yaml`**，除非确实新增 / 升级了依赖
- ✅ **数据库迁移**：所有新增的表结构 / 字段变更需放到 `docs/migrations/<yyyy-mm-dd>-<short-name>.sql`，并保证幂等
- ✅ **不提交密钥**：检查 `.env.local`、连接串、API Key、Token 不能出现在 diff 中
- ✅ **保持向后兼容**：除非有充分理由并在 PR 中说明

---

## 本地开发环境

### 前置依赖

| 工具 | 版本 |
| --- | --- |
| Node.js | ≥ 22 |
| pnpm | 10.x（推荐 `corepack enable && corepack prepare pnpm@10.28.1 --activate`） |
| PostgreSQL | 16+（推荐直接用 Supabase 免费实例） |
| S3 兼容存储 | Bitiful / R2 / S3 / MinIO 任选 |

### 启动

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
# 编辑 apps/web/.env.local 填入真实值，详见 README

pnpm --silent --filter @petrichor/web db:sql > petrichor-init.sql
# 把上面生成的 SQL 在 Supabase SQL Editor 跑一遍

pnpm dev
```

---

## 代码风格

详细规范见 [`AGENTS.md`](AGENTS.md)。简要：

### TypeScript

- 严格 TS，禁止 `any`，优先复用现有类型
- 路径别名 `@/*` 指向 `apps/web/src/*`
- 服务端文件多为 4 空格缩进；前端 / shadcn 组件按生成时风格

### 后端 (Next.js Route Handler)

- `route.ts` 保持薄层，只导出对应 handler：
  ```ts
  export { listKnowledgeBases as POST } from "@/server/kb/handlers"
  ```
- 入参使用 **Zod** 校验；统一使用 `readJson`、`ok`、`tableData`、`toErrorResponse` 等响应工具
- 需要登录的接口使用 `requireCurrentUser(request)`；管理员接口需再次校验 `SUPER_ADMIN`
- 错误响应统一为 `{ code, msg, path, timestamp }`，不要泄露内部错误细节

### 前端

- 优先复用 `apps/web/src/components/ui`、shadcn-studio、cuicui 和现有业务组件
- 图标优先 `lucide-react` 或 `@tabler/icons-react`
- 新页面应接入现有 `react-router-dom` 路由、主题、侧栏和面包屑体系
- UI 改动完成后请在浏览器中验证桌面 & 移动视口

### 文档与注释

- 注释和文档默认中文；库 API / 协议字段保持英文
- 不写解释"做了什么"的注释（命名应已自解释）；只在 **为什么** 不明显时加注释
- 不写引用当前任务的注释（如 "添加于 issue #123"）—— 这类信息属于 PR 描述

---

## Commit 规范

推荐使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <短描述>

<可选正文：详细说明 / 动机 / 影响>
```

常用 `type`：

- `feat` — 新功能
- `fix` — Bug 修复
- `docs` — 文档变更
- `refactor` — 重构（无功能变化）
- `test` — 测试相关
- `chore` — 杂项（依赖升级、配置等）
- `perf` — 性能优化

示例：

```
feat(ai-review): 新增 AI 周报 / 月报功能

- 新增 petrichor_ai_review 表
- 新增 /api/ai-review handler 与前端页面
- 单元测试覆盖 prompt 拼装与周期计算
```

---

## 验证清单

**提交 PR 前必须全部通过**：

```bash
pnpm typecheck       # TypeScript 类型检查
pnpm lint            # ESLint
pnpm test            # Vitest 单元测试
```

涉及构建产物或路由变更时追加：

```bash
pnpm build
```

如果有 UI 改动，请在 PR 描述中附上桌面 + 移动视口的截图或录屏。

---

## 安全漏洞报告

**不要** 通过公开 Issue 报告安全漏洞。请通过以下方式私下联系维护者：

- 在 GitHub 仓库使用 **Security → Report a vulnerability** 通道（推荐）
- 或邮件联系仓库维护者

我们承诺：

- 在 48 小时内确认收到
- 在修复发布前不公开漏洞详情
- 在发布说明中致谢报告者（除非你希望匿名）

---

感谢你为 Petrichor 做出贡献 ❤️
