# @petrichor/web

Next.js + TypeScript 全栈应用，包管理、本地服务与生产服务端运行时统一使用 **Bun 1.3.14**，目标部署环境为 **Vercel**，数据层使用 **Supabase PostgreSQL**。

> 📖 完整的简介、功能特性、Vercel 一键部署、环境变量速查表请看仓库根目录的 [`README.md`](../../README.md)。

## 本地开发

```bash
bun install
bun dev
```

只运行当前应用：

```bash
bun --filter "@petrichor/web" dev
```

## 环境变量

复制 `.env.example` 并填入数据库、Session、加密密钥和对象存储配置：

```bash
cp apps/web/.env.example apps/web/.env.local
```

每一项的作用见根 README 的[环境变量速查表](../../README.md#-环境变量速查表)。

## 初始化数据库

```bash
bun --silent run db:sql > petrichor-init.sql
```

将输出 SQL 放到 Supabase SQL Editor 执行。SQL 会创建 Better Auth 认证表和业务表。

认证使用 Better Auth + Drizzle，浏览器端通过 httpOnly Cookie 保持登录状态，不再依赖 `localStorage` token。

## 质量检查

```bash
bun test
bun typecheck
bun lint
bun build
```
