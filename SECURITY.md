# 安全策略

## 报告漏洞

请不要在公开 Issue 中披露可利用细节、真实凭证或用户数据。优先使用 GitHub 仓库的
**Security → Report a vulnerability** 私密报告入口，并提供：

- 受影响版本或提交；
- 最小复现步骤与影响范围；
- 是否需要特定权限、配置或用户交互；
- 建议修复方案（如有）。

维护者确认前请勿公开利用代码。收到报告后会先确认影响，再协调修复与披露时间。

## 支持范围

当前仅维护 `master` 最新版本。自托管部署者应及时同步安全更新，并在升级前备份数据库和
`config.toml` 中不可替换的加密参数。

## 部署基线

- 生产环境必须设置随机且稳定的 `encryption.key` 与 `encryption.salt`，服务会拒绝示例值。
- `server.trusted_proxies` 只能填写实际位于 API 前方的代理 IP/CIDR，禁止为图方便信任整个公网。
- TLS 应在入口代理终止；Cookie 在 production 模式下自动启用 `Secure`。
- 不要把 `config.toml`、`.env.local`、数据库备份或对象存储凭证提交到仓库。
- `/healthz` 用于存活探测，`/readyz` 会同时检查数据库与已配置的 Redis。
- Compose 只向公网暴露 Caddy 的 80/443；API 8080 和 Redis 6379 不得开放公网访问。

## 凭证密文兼容

新写入的敏感字段使用带版本前缀的 HKDF-SHA256 + AES-256-GCM 随机 nonce 密文，能够检测篡改。
服务保留旧 AES-CBC 密文的只读兼容，存量凭证在用户下次保存时自然升级；为避免未经确认地批量改写
生产数据，启动过程不会自动重加密整表。迁移期间不得更换原有 key/salt。

## 依赖审计说明

CI 会运行 Bun 与 Go 漏洞扫描。暂时无法兼容升级的直接依赖只有在仓库内补丁已经关闭漏洞路径后，
才能按 GHSA 编号加入审计忽略项：`js-video-url-parser` 的 GHSA-8fgx-wgvr-pcx8 由本地补丁
替换灾难性回溯正则并限制输入长度；`@platejs/docx-io` 的 GHSA-4q39-2jhr-7qx8 由本地补丁
默认禁止 DOCX 导出抓取远程图片，仅保留可信内容显式启用。两者补丁均位于 `apps/web/patches/`，
删除补丁或升级到上游修复版本时必须同步删除对应忽略项。其余可兼容修复的传递依赖使用
`overrides` 固定到已修复版本，不应添加审计例外。
