<div align="center">

<img src="apps/web/public/sidebar-logo.jpg" alt="Petrichor" width="120" height="120" />

# Petrichor

**一个开箱即用的全栈知识库与博客平台 · 基于 Next.js + Supabase + Vercel**

*An open-source full-stack knowledge base & blog platform built with Next.js, Supabase and Vercel.*

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Supabase](https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
[![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel)](https://vercel.com)

[**🌐 产品官网**](https://petrichor.wl.do) ·
[**📖 在线 Demo（前台）**](https://wl.do)

[**🚀 一键部署到 Vercel**](#-vercel-一键部署傻瓜式教程) ·
[功能特性](#-功能特性) ·
[环境变量](#-环境变量速查表) ·
[本地开发](#-本地开发) ·
[English](#english)

</div>

---

## 📖 简介

**Petrichor**是一个个人/小团队场景下的现代化知识库与博客平台，集成了富文本编辑器、知识库管理、文章发布、AI 写作助手、AI 回顾周报/月报、对象存储上传等能力。

整套系统目标运行环境为 **Vercel + Supabase**，零自建服务器即可上线，仅需配置好环境变量就能拥有一个完整可用的内容平台。

---

## ✨ 功能特性

| 模块 | 能力 |
| --- | --- |
| **📝 富文本编辑器** | 基于 PlateJS，支持 Markdown、代码块、表格、数学公式、白板、思维导图、媒体嵌入等 |
| **📚 知识库** | 多层级目录树、文章标签、文章分享、文章 RSS/Atom Feed |
| **🤖 AI 助手** | AI 续写 / 改写 / 翻译 / 语气调整、AI 文章总结、AI 周报 & 月报回顾 |
| **🔐 认证体系** | Better Auth + httpOnly Cookie，支持邮箱密码、LinuxDo OAuth、二步验证 |
| **🗂️ 对象存储** | S3 兼容上传（封面、附件、头像），支持预签名 URL |
| **📊 仪表盘** | 写作数据统计、活跃度图、知识库分布 |
| **🎨 主题与外观** | 浅色/深色模式、自定义网站标题/图标、Retypeset 主题博客首页 |
| **🌐 公开站点** | 文章公开页、SEO 元数据、RSS、Atom、sitemap.xml |
| **🛠️ Agent 集成** | API Key 管理、Skill 包（兼容 Claude Code / Codex）、调用审计日志、REST 能力层 |

---

## 🚀 Vercel 一键部署（傻瓜式教程）

> 整个过程大约 **5–10 分钟**，无需懂代码，只要会复制粘贴。

### 第 1 步：准备一个 Supabase 数据库（免费）

1. 打开 <https://supabase.com>，注册并登录。
2. 点击 **New Project**，填写项目名（如 `petrichor`），设置一个数据库密码，**密码记下来**。
3. 等待数据库初始化完成（约 1–2 分钟）。
4. 进入 **Project Settings → Database → Connection string**，选择 **Transaction (port 6543)** 模式，复制连接串。它形如：
   ```
   postgresql://postgres.xxxxxxx:你的密码@aws-1-us-west-2.pooler.supabase.com:6543/postgres
   ```
   这串就是后面要填的 **`DATABASE_URL`**。

### 第 2 步：准备一个 S3 兼容的对象存储

任选其一即可，都有免费额度：

| 服务 | 推荐场景 | 链接 |
| --- | --- | --- |
| **缤纷云 Bitiful** | 国内访问快、免费额度大 | <https://www.bitiful.com> |
| **Cloudflare R2** | 海外、零出口费用 | <https://developers.cloudflare.com/r2/> |
| **AWS S3** | 标准方案 | <https://aws.amazon.com/s3/> |
| **MinIO** | 自托管 | <https://min.io> |

创建一个 Bucket（公开读权限），并获取以下信息：

- **S3_ENDPOINT**：S3 API 地址，例如 `https://blog-1.s3.bitiful.net`
- **S3_REGION**：区域，例如 `cn-east-1`、`us-east-1`、`auto`
- **S3_BUCKET**：桶名
- **S3_ACCESS_KEY_ID** / **S3_SECRET_ACCESS_KEY**：访问密钥对

### 第 3 步：生成必要的密钥

随机生成 3 串密钥，本地终端执行（macOS / Linux 通用）：

```bash
# SESSION_SECRET：32 字节 base64
openssl rand -base64 32

# PETRICHOR_ENCRYPT_KEY：32 字节 base64
openssl rand -base64 32

# PETRICHOR_ENCRYPT_SALT：8 字节 hex（16 位十六进制）
openssl rand -hex 8
```

> Windows 用户：可在 <https://www.random.org/bytes/> 上分别生成对应长度的随机串，或用 PowerShell 的 `[Convert]::ToBase64String((1..32 | %{[byte](Get-Random -Min 0 -Max 256)}))`。

把这 3 串结果先保存到记事本，待会儿填到 Vercel。

### 第 4 步：点击下方按钮，一键部署

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLittleBunVerse%2FDosphere-vercel&project-name=petrichor&repository-name=petrichor&root-directory=apps%2Fweb&env=DATABASE_URL,SESSION_SECRET,PETRICHOR_ENCRYPT_KEY,PETRICHOR_ENCRYPT_SALT,S3_ENDPOINT,S3_REGION,S3_BUCKET,S3_ACCESS_KEY_ID,S3_SECRET_ACCESS_KEY,NEXT_PUBLIC_APP_URL&envDescription=%E5%A1%AB%E5%85%A5%E6%95%B0%E6%8D%AE%E5%BA%93%E3%80%81%E4%BC%9A%E8%AF%9D%E5%AF%86%E9%92%A5%E3%80%81%E5%8A%A0%E5%AF%86%E5%AF%86%E9%92%A5%E5%92%8C%E5%AF%B9%E8%B1%A1%E5%AD%98%E5%82%A8%E7%AD%89%E5%BF%85%E5%A1%AB%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F&envLink=https%3A%2F%2Fgithub.com%2FLittleBunVerse%2FDosphere-vercel%23-%E7%8E%AF%E5%A2%83%E5%8F%98%E9%87%8F%E9%80%9F%E6%9F%A5%E8%A1%A8)

按钮会自动：

- ✅ 把当前仓库 Fork 到你自己的 GitHub
- ✅ 在 Vercel 创建一个新项目
- ✅ 把 **Root Directory** 自动设为 `apps/web`
- ✅ 弹出表单让你填入所有**必填**环境变量

按照下表把第 1–3 步收集到的值粘贴进去：

| 字段 | 填什么 |
| --- | --- |
| `DATABASE_URL` | 第 1 步 Supabase 的 Transaction Pooler 连接串 |
| `SESSION_SECRET` | 第 3 步生成的 base64（必须 ≥ 32 字符） |
| `PETRICHOR_ENCRYPT_KEY` | 第 3 步生成的 base64 |
| `PETRICHOR_ENCRYPT_SALT` | 第 3 步生成的 16 位 hex |
| `S3_ENDPOINT` | 第 2 步的 S3 接入点 |
| `S3_REGION` | 第 2 步的区域名 |
| `S3_BUCKET` | 第 2 步的桶名 |
| `S3_ACCESS_KEY_ID` | 第 2 步的 Access Key ID |
| `S3_SECRET_ACCESS_KEY` | 第 2 步的 Secret Access Key |
| `NEXT_PUBLIC_APP_URL` | **先随便填 `http://localhost:3000`，部署完成后再来改成你的 Vercel 域名（如 `https://你的项目.vercel.app`）** |

填完点 **Deploy**，等待 2–4 分钟构建完成。

### 第 5 步：初始化数据库表结构（只做一次）

部署完成后，先把数据库表建好，否则页面会报错。

1. 在本地终端把项目克隆下来（用第 4 步 fork 出去的仓库）：
   ```bash
   git clone https://github.com/你的用户名/petrichor.git
   cd petrichor
   pnpm install
   ```
2. 生成初始化 SQL：
   ```bash
   pnpm --silent --filter @petrichor/web db:sql > petrichor-init.sql
   ```
3. 打开 Supabase → **SQL Editor** → **New query**，把 `petrichor-init.sql` 全部内容粘贴进去，点 **Run** 执行。
4. 看到 “Success. No rows returned” 即代表表结构已就绪。

> 不想本地装环境？直接打开仓库里的 [`docs/petrichor-init.sql`](docs/petrichor-init.sql) 复制粘贴也行。该文件随仓库提供，与最新表结构同步。

### 第 6 步：创建第一个超级管理员账号

> ⚠️ **初始化 SQL 不会自动创建任何用户**。数据库刚跑完上一步时是空的，需要自己造一个超级管理员。
>
> 二选一，**推荐方法 A**（不用写 SQL、不用懂 bcrypt）。

#### 方法 A：临时开放注册 → 注册 → 关闭注册（推荐）

1. 在 Vercel → **Settings → Environment Variables** 新增两个变量（**所有环境**勾选 Production / Preview / Development）：

   | 变量 | 临时填 |
   | --- | --- |
   | `NEXT_PUBLIC_REGISTER_ENABLED` | `true` |
   | `PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE` | `SUPER_ADMIN` |

2. 进入 **Deployments → ⋯ → Redeploy** 让新环境变量生效（约 2 分钟）。
3. 打开你的 Vercel 域名 `https://你的项目.vercel.app/login`，**点「注册」**，填邮箱和密码，提交。
4. 注册成功后立即返回 Vercel → Environment Variables，把上面两个变量改回安全值：

   | 变量 | 改回 |
   | --- | --- |
   | `NEXT_PUBLIC_REGISTER_ENABLED` | `false` |
   | `PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE` | `USER` |

5. 再点一次 **Redeploy**，登录页的「注册」入口就消失了，从此只有管理员能从后台手动加用户。

#### 方法 B：直接在 Supabase SQL Editor 插入（需要本地 Node）

1. 在本地仓库目录生成 bcrypt 密码哈希（先 `pnpm install` 安装依赖）：
   ```bash
   cd apps/web
   node -e "console.log(require('bcryptjs').hashSync('替换成你的明文密码', 10))"
   ```
   会输出形如 `$2a$10$...` 的哈希串，复制下来。

2. 打开 Supabase → SQL Editor，粘贴下面 SQL，把 3 个占位符替换后 **Run**：

   ```sql
   do $$
   declare
       v_email         text := 'admin@example.com';                    -- 改成你的邮箱
       v_password_hash text := '$2a$10$把上一步的哈希粘贴到这里';        -- 改成上面生成的哈希
       v_nickname      text := 'Admin';                                -- 显示名
       v_auth_user_id  text := gen_random_uuid()::text;
       v_username      text := split_part(v_email, '@', 1);
   begin
       insert into better_auth_user (id, name, email, email_verified, created_at, updated_at)
       values (v_auth_user_id, v_nickname, lower(v_email), true, now(), now())
       on conflict (email) do nothing;

       insert into petrichor_user (auth_user_id, email, password_hash, system_role, user_type, username, nickname)
       values (v_auth_user_id, lower(v_email), v_password_hash, 'SUPER_ADMIN', 'LOCAL', v_username, v_nickname)
       on conflict (email) do nothing;

       insert into better_auth_account (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values (gen_random_uuid()::text, v_auth_user_id, 'credential', v_auth_user_id, v_password_hash, now(), now())
       on conflict (provider_id, account_id) do nothing;
   end $$;
   ```

3. 用这个邮箱密码登录即可。

### 第 7 步：回填 `NEXT_PUBLIC_APP_URL` 并重新部署

1. 在 Vercel 项目首页找到自己分配到的域名，例如 `https://petrichor-abc123.vercel.app`。
2. 进入 **Settings → Environment Variables**，把 `NEXT_PUBLIC_APP_URL` 改成上面这个域名（**不要带斜杠结尾**）。
3. 进入 **Deployments**，对最新一次部署点 **⋯ → Redeploy**。

**完成！** 🎉 用第 6 步创建的管理员账号登录，开始使用。

---

## 🔐 环境变量速查表

### ✅ 必填（缺一不可，否则启动失败）

| 变量 | 类型 / 校验 | 用于什么功能 |
| --- | --- | --- |
| `DATABASE_URL` | Postgres 连接串，非空 | **所有数据持久化**：用户、文章、知识库、通知、AI 配置、上传记录等。生产环境务必使用 Supabase **Transaction Pooler** 连接串（端口 6543） |
| `SESSION_SECRET` | base64 字符串，**至少 32 字符** | **登录会话 Cookie 签名**（Better Auth）。一旦上线**不要修改**，否则所有已登录用户会被踢下线 |
| `PETRICHOR_ENCRYPT_KEY` | base64 字符串，建议 32 字节 | **AI 模型 API Key 加密存储**。用户在后台配置的 OpenAI / Gemini / DeepSeek API Key 都会用它加密后写入数据库 |
| `PETRICHOR_ENCRYPT_SALT` | 16 位十六进制字符串 | 与 `PETRICHOR_ENCRYPT_KEY` 配套使用的盐值。**一旦有真实数据后不能再换**，否则历史密文无法解密 |

### 📦 对象存储（上传相关功能依赖；不配则上传按钮会报错）

| 变量 | 用于什么功能 |
| --- | --- |
| `S3_ENDPOINT` | S3 接入点（含或不含 `https://` 均可，未带协议时会自动按 `S3_USE_SSL` 补全） |
| `S3_REGION` | 区域，默认 `us-east-1` |
| `S3_BUCKET` | 存储桶名 |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | S3 凭据，用于服务端签名预签名 URL |
| `S3_UPLOAD_EXPIRE_SECONDS` | 上传用预签名 URL 有效期（秒），默认 `900` |
| `S3_DOWNLOAD_EXPIRE_SECONDS` | 下载用预签名 URL 有效期（秒），默认 `3600` |
| `S3_USE_SSL` | `S3_ENDPOINT` 未带协议时是否补 `https://`，默认 `true` |

**用到 S3 的功能：** 文章封面上传、附件上传、用户头像上传、知识库文件附件、AI 文章总结配图等。

### 🌐 应用与公开页

| 变量 | 用于什么功能 |
| --- | --- |
| `NEXT_PUBLIC_APP_URL` | **公开站点完整 URL**（如 `https://yourdomain.com`）。用于：文章分享链接、RSS/Atom 链接生成、OAuth 回调地址 fallback、SEO `og:url`。部署完成后**务必回填**为真实域名 |
| `NEXT_PUBLIC_REGISTER_ENABLED` | 是否在登录页显示「注册」入口，`"true"` / `"false"`，默认 `"false"`（关闭注册，仅管理员手动添加用户） |
| `PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE` | 开放注册时新用户默认角色，只允许 `USER` 或 `SUPER_ADMIN`。**首次部署可临时设为 `SUPER_ADMIN`，注册首个账号后立刻改回 `USER`** |
| `PETRICHOR_SESSION_EXPIRE_SECONDS` | 登录态有效期（秒），默认 `172800`（2 天） |

### 🔗 LinuxDo OAuth（可选第三方登录）

不需要 LinuxDo 登录可以**全部留空**。

| 变量 | 用于什么功能 |
| --- | --- |
| `PETRICHOR_LINUXDO_CLIENT_ID` | LinuxDo OAuth 应用 Client ID |
| `PETRICHOR_LINUXDO_CLIENT_SECRET` | LinuxDo OAuth 应用 Client Secret |
| `PETRICHOR_LINUXDO_REDIRECT_URI` | OAuth 回调地址，需与 LinuxDo 应用注册一致；留空则取 `NEXT_PUBLIC_APP_URL + /api/auth/callback` |

> 在 <https://connect.linux.do> 注册一个 OAuth 应用即可获得 ID 和 Secret，回调地址填 `https://你的域名/api/auth/callback`。

---

## 🛠️ Agent 集成（Skill 包 / REST 能力层）

Petrichor 内置了一套**面向外部 Agent**（Claude Code、Codex、Cursor、ChatGPT 桌面端等）的开放能力，让 AI 工具能直接读写你的知识库。

### 能力一览

| 子模块 | 入口 | 说明 |
| --- | --- | --- |
| **API Key 管理** | 仪表盘 → Agent 集成 → API Key 管理 | 生成 / 撤销外部 Agent 调用密钥。明文仅展示一次，服务端只存 `sha256` 哈希 |
| **Skill 包** | 仪表盘 → Agent 集成 → Skill 包 | 下载 `petrichor-agent-skills.zip`，内含多个 `SKILL.md`，导入 Claude Code / Codex 即可使用；兼容旧单文件 `SKILL.md` |
| **调用日志** | 仪表盘 → Agent 集成 → 调用日志 | 完整审计：来源 Agent、工具、IP、UA、入参、出参、状态码、耗时 |
| **REST 能力层** | `/api/agent/**` | 所有外部接口统一鉴权 + 审计，可直接被任意 HTTP 客户端调用 |

### Skill 包结构

下载后的压缩包内置 4 个 Skill，覆盖典型 Agent 使用场景：

| Skill | 用途 |
| --- | --- |
| `petrichor-setup` | 环境变量自检、接口发现（基于 `/api/agent/manifest`） |
| `petrichor-articles` | 新建 / 更新 / 删除文章、创建文件夹 |
| `petrichor-docs` | 知识库列表、目录树、文档搜索、文档查看 |
| `petrichor-qa` | 基于知识库上下文的文档问答 |

### 接入步骤

1. **生成 API Key**：仪表盘 → **Agent 集成 → API Key 管理 → 新建**，按需勾选权限（`article:write` / `article:delete` / `doc:read` / `qa:read`），保存明文。
2. **下载 Skill 包**：仪表盘 → **Agent 集成 → Skill 包 → 下载包**，得到 `petrichor-agent-skills.zip`。
3. **导入 Agent 工具**：解压后将 Skill 目录放入 Claude Code / Codex 对应的 Skills 路径（参考各工具文档）。
4. **配置环境变量**（在 Agent 工具侧）：
   - `PETRICHOR_BASE_URL`：你的 Petrichor 站点根 URL，如 `https://你的项目.vercel.app`
   - `PETRICHOR_API_KEY`：上一步生成的明文 Key
5. **调用约定**：所有外部请求必须携带：
   - `Authorization: Bearer <apiKey>`
   - `X-Petrichor-Agent-Source: <agent 标识>`（缺失会被拒绝并写入审计日志）
6. **审计**：每次调用都会自动写入「调用日志」，登录用户可在仪表盘内回看。

> 公开接口清单：未带鉴权也能访问的 `GET /api/agent/manifest` 会列出全部可用接口、参数和所需权限，方便 Agent 自动发现能力。详细设计见 [`docs/agent-integration.md`](docs/agent-integration.md)。

### 🧪 完整模板

参考 [`apps/web/.env.example`](apps/web/.env.example) 或直接复制：

```ini
# 必填
DATABASE_URL="postgres://postgres:[password]@[host]:6543/postgres"
SESSION_SECRET="<openssl rand -base64 32 的输出>"
PETRICHOR_ENCRYPT_KEY="<openssl rand -base64 32 的输出>"
PETRICHOR_ENCRYPT_SALT="<openssl rand -hex 8 的输出>"

# S3 兼容对象存储
S3_ENDPOINT="https://s3.example.com"
S3_REGION="us-east-1"
S3_BUCKET="your-bucket"
S3_ACCESS_KEY_ID="your-access-key-id"
S3_SECRET_ACCESS_KEY="your-secret-access-key"
S3_UPLOAD_EXPIRE_SECONDS="900"
S3_DOWNLOAD_EXPIRE_SECONDS="3600"
S3_USE_SSL="true"

# 应用 URL 与注册策略
NEXT_PUBLIC_APP_URL="https://yourdomain.com"
NEXT_PUBLIC_REGISTER_ENABLED="false"
PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE="USER"
PETRICHOR_SESSION_EXPIRE_SECONDS="172800"

# 可选：LinuxDo OAuth
PETRICHOR_LINUXDO_CLIENT_ID=""
PETRICHOR_LINUXDO_CLIENT_SECRET=""
PETRICHOR_LINUXDO_REDIRECT_URI=""
```

---

## 💻 本地开发

### 前置依赖

- Node.js **≥ 22**
- pnpm **10.x**（推荐 `corepack enable && corepack prepare pnpm@10.28.1 --activate`）
- 一个可用的 Postgres 数据库（Supabase / 本地 Docker / 远程均可）

### 启动

```bash
git clone https://github.com/LittleBunVerse/Dosphere-vercel.git petrichor
cd petrichor
pnpm install
cp apps/web/.env.example apps/web/.env.local
# 编辑 apps/web/.env.local 填入真实值

# 初始化数据库（生成 SQL 后到 Supabase / psql 执行）
pnpm --silent --filter @petrichor/web db:sql > petrichor-init.sql

pnpm dev
```

打开 <http://localhost:3000>。

### 常用命令

```bash
pnpm dev           # 启动开发服务器
pnpm build         # 生产构建
pnpm test          # 单元测试（Vitest）
pnpm typecheck     # TypeScript 类型检查
pnpm lint          # ESLint
```

---

## 📁 项目结构

```
.
├── apps/
│   └── web/                     # Next.js 全栈应用
│       ├── app/                 # App Router 入口、API route、RSS/sitemap
│       │   └── api/agent/       # 外部 Agent REST 能力层（manifest / skill / skill-pack 等）
│       ├── src/
│       │   ├── client-app.tsx   # 客户端 SPA 入口
│       │   ├── features/pages/  # 业务页面（dashboard / blog / kb / ai / agent / admin ...）
│       │   ├── components/      # 通用组件 + shadcn/ui
│       │   ├── lib/             # 前端工具与 API client
│       │   ├── server/          # 服务端 handler / 业务逻辑 / Drizzle schema
│       │   │   └── agent/       # Agent 接入逻辑：API Key、Skill 生成、审计
│       │   └── config/          # 环境变量解析与服务端配置
│       └── .env.example
├── docs/
│   ├── petrichor-init.sql       # 完整初始化 SQL（与代码同步）
│   ├── create-first-admin.sql   # 创建第一个超级管理员账号的 SQL 模板
│   ├── agent-integration.md     # Agent 集成（Skill 包 / REST）设计说明
│   ├── migrations/              # 历史增量迁移脚本
│   └── assets/                  # 文档资源（logo 等）
├── AGENTS.md                    # 给 AI 协作者的项目级说明
├── LICENSE                      # Apache 2.0
└── README.md
```

---

## 🤝 贡献

欢迎 Issue / PR。提交前请确保：

```bash
pnpm typecheck
pnpm lint
pnpm test
```

全部通过。

代码风格、提交约定、UI 复用与目录规范详见 [`AGENTS.md`](AGENTS.md)。

---

## 🙏 致谢

- 本项目的前台公开站点 UI 与排版设计借鉴自 [**astro-theme-retypeset**](https://github.com/radishzzz/astro-theme-retypeset) —— 一个优雅、克制、专注阅读的 Astro 博客主题。感谢作者 [@radishzzz](https://github.com/radishzzz) 在中文排版与视觉细节上的精心打磨，为本项目的公开页提供了重要灵感。

---

## 📄 License

[Apache License 2.0](LICENSE) © 2026 Petrichor Contributors

---

## English

**Petrichor** (repo codename *Dosphere*) is a self-hostable knowledge-base & blog platform powered by **Next.js 16 + Supabase + Vercel**, featuring a PlateJS rich-text editor, multi-level knowledge tree, AI writing assistant (continue / rewrite / translate / tone), AI weekly & monthly reviews, S3-compatible uploads, Better Auth with optional LinuxDo OAuth, and an **Agent integration layer** (REST + downloadable Skill packs compatible with Claude Code / Codex) with full call auditing.

### Links

- 🌐 **Product site**: <https://petrichor.wl.do>
- 📖 **Live demo (public site)**: <https://wl.do>

### Quick deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FLittleBunVerse%2FDosphere-vercel&project-name=petrichor&repository-name=petrichor&root-directory=apps%2Fweb&env=DATABASE_URL,SESSION_SECRET,PETRICHOR_ENCRYPT_KEY,PETRICHOR_ENCRYPT_SALT,S3_ENDPOINT,S3_REGION,S3_BUCKET,S3_ACCESS_KEY_ID,S3_SECRET_ACCESS_KEY,NEXT_PUBLIC_APP_URL)

1. **Provision Postgres** — create a free Supabase project, copy the **Transaction Pooler** connection string (port 6543) as `DATABASE_URL`.
2. **Provision object storage** — any S3-compatible service (Bitiful / R2 / S3 / MinIO). Collect endpoint, region, bucket, access key, secret.
3. **Generate secrets**:
   ```bash
   openssl rand -base64 32   # SESSION_SECRET
   openssl rand -base64 32   # PETRICHOR_ENCRYPT_KEY
   openssl rand -hex 8       # PETRICHOR_ENCRYPT_SALT
   ```
4. **Click the deploy button** above and fill the env form.
5. **Initialize the database**: run `pnpm --silent --filter @petrichor/web db:sql` (or copy [`docs/petrichor-init.sql`](docs/petrichor-init.sql)) into Supabase SQL Editor.
6. **Create the first super-admin** — the init SQL does **not** seed any user. Two options:
   - **Recommended (no SQL):** temporarily set `NEXT_PUBLIC_REGISTER_ENABLED=true` and `PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE=SUPER_ADMIN` on Vercel → redeploy → register from `/login` → revert both vars and redeploy.
   - **Via SQL:** generate a bcrypt hash locally (`cd apps/web && node -e "console.log(require('bcryptjs').hashSync('YourPwd', 10))"`) and run [`docs/create-first-admin.sql`](docs/create-first-admin.sql) in Supabase with your email + hash filled in.
7. **Set `NEXT_PUBLIC_APP_URL`** to your deployed Vercel domain and redeploy.

### Required env

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection (use Supabase Transaction Pooler in production) |
| `SESSION_SECRET` | Better Auth cookie signing key (≥ 32 chars) |
| `PETRICHOR_ENCRYPT_KEY` / `PETRICHOR_ENCRYPT_SALT` | AES-style encryption for stored AI provider API keys |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Object storage for uploads (article covers, attachments, avatars) |
| `NEXT_PUBLIC_APP_URL` | Public site URL — used by RSS, share links, OAuth callbacks, SEO metadata |

### Optional env

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_REGISTER_ENABLED` | Show the "Sign up" entry on the login page (`true` / `false`) |
| `PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE` | Default role for self-registered users — `USER` or `SUPER_ADMIN` |
| `PETRICHOR_SESSION_EXPIRE_SECONDS` | Session lifetime in seconds (default `172800`) |
| `PETRICHOR_LINUXDO_CLIENT_ID` / `PETRICHOR_LINUXDO_CLIENT_SECRET` / `PETRICHOR_LINUXDO_REDIRECT_URI` | LinuxDo OAuth (optional third-party login) |

See the full breakdown in the [Chinese section above](#-环境变量速查表).

### Agent integration

Petrichor exposes a permissioned REST layer at `/api/agent/**` for external AI agents (Claude Code, Codex, Cursor, ChatGPT Desktop, …), together with a downloadable **Skill pack** bundling 4 ready-to-use Skills (`petrichor-setup`, `petrichor-articles`, `petrichor-docs`, `petrichor-qa`).

1. **Generate an API key** in *Dashboard → Agent 集成 → API Key 管理* (plaintext shown once; only `sha256` is persisted).
2. **Download the Skill pack** (`petrichor-agent-skills.zip`) and import it into your agent tool.
3. **Set agent-side env vars**: `PETRICHOR_BASE_URL` (your deployment URL) and `PETRICHOR_API_KEY`.
4. **Call convention**: every request must carry `Authorization: Bearer <key>` and `X-Petrichor-Agent-Source: <agent-id>` — missing the source header fails the call and is logged for audit.
5. **Audit**: every call (source, tool, IP, UA, request, response, status, latency) is recorded in *Dashboard → Agent 集成 → 调用日志*.

Public manifest endpoint (no auth) for capability discovery: `GET /api/agent/manifest`. Full design notes in [`docs/agent-integration.md`](docs/agent-integration.md).

### Acknowledgements

The public-facing site's UI and typography were inspired by [**astro-theme-retypeset**](https://github.com/radishzzz/astro-theme-retypeset) by [@radishzzz](https://github.com/radishzzz) — an elegant, reading-focused Astro blog theme with carefully crafted CJK typography.

### License

[Apache License 2.0](LICENSE)
