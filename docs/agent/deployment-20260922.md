# Pi Agent 扩展部署记录

日期：2026-09-22。根据用户授权，部署到现有 Debian 13 服务器，站点为 <https://wl.do>。

## 发布内容

- 发布标识：`pi-20260922-v1`；从当前工作区完整构建，包含未提交修改，不是仅部署 Git HEAD。
- API / Worker 镜像：`petrichor-api:pi-20260922-v1`，镜像 ID `sha256:4f8ca243b150ad39c493dcbacc7a1c911d96e7cdd0eb77a23c1c207d2fd70250`。
- Web 镜像：`petrichor-web:pi-20260922-v1`，镜像 ID `sha256:8a505b72614d65a0c8f08a1066dd8cb19c2a84e7ff05ae8786a3025ec417da9d`。
- 保留服务器原有 Compose、Caddy 域名/官网配置、数据库、Redis、模型网关和数据卷；通过 `compose.override.yaml` 指定本次镜像和独立工具网络。
- 启用 Pi、助手与 Wiki 文件 Skills、运行控制与检查点；迁移 `202609220001` 只新增检查点表。
- 浏览器 MCP 使用固定镜像 `mcr.microsoft.com/playwright/mcp@sha256:77dccc5ce9e94cb8ae7ebea87ddbb6cd54b05760c4d63c54e16accf2726b8734`，独立会话，不发布主机端口，不加入数据库网络。
- 沙箱通过独立 `petrichor-sandbox.service` 运行，绑定 Docker 工具网络网关；API 不挂载 Docker socket。浏览器与沙箱默认仅操作员可用。
- 外部 Reranker 未配置独立凭据，保留本地排序。

## 验证

- 全部镜像构建成功，API 健康，Worker / Web 正常运行，检查时重启次数为 0。
- 生产镜像内 Pi 完成模拟模型—真实工具协议—模拟模型循环；未为验收调用付费模型。
- 真实 Python / JavaScript 沙箱均返回预期结果；API 容器到受鉴权沙箱执行通过。
- Playwright MCP 工具发现、真实 Chromium 导航与页面读取、两个 MCP 会话的上下文隔离均通过；API 容器到 MCP 握手通过。
- 公网 `/`、`/healthz`、`/readyz` 和入口静态资源均返回 HTTP 200；首页 SHA-256 与新 Web 镜像完全一致。
- 本机 ego-lite 已打开线上首页，确认标题、导航和页面框架正常显示。
- 检查时 API / Worker / Web 日志未发现 panic、fatal 或 error 级别记录。未使用用户账号执行完整助手对话或 Wiki 构建验收。

## 备份与回滚

以下路径均位于服务器：

- 运行目录：`/opt/petrichor`。
- 发布源码、构建/部署日志及脚本：`/opt/petrichor/releases/pi-20260922-v1`。
- PostgreSQL dump、Redis RDB、原始配置和旧镜像 ID：`/opt/petrichor/backups/pi-20260922-v1`。备份目录仅 root 可访问。
- 主应用回滚脚本：`/opt/petrichor/releases/pi-20260922-v1/rollback.sh`。脚本恢复旧配置和旧 API / Worker / Web 镜像，不回滚数据库、不删除新增检查点表，也不删除数据卷。

## ego-lite 兼容性

截至本次核对，[ego-lite 官方 README](https://github.com/citrolabs/ego-lite#quick-start) 只提供 macOS 版本，Linux 仍在规划中，不能直接替换 Debian 上的浏览器服务。本机网站验收可使用 ego-lite；若要让服务器 Agent 控制 Mac 上的 ego-lite，需要另行实现经过认证且按用户隔离的连接服务，当前尚未接入。
