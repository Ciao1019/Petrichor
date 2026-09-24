# 网页采集精简与删除功能部署记录

日期：2026-09-22。站点：<https://wl.do>。发布标识：`capture-20260922-v2`。

## 发布范围

- 以服务器已运行的 `pi-20260922-v1` 源码为基础，仅叠加本次采集界面、删除接口及相应测试和文档，共 26 个文件。没有发布工作区中的其他改动。
- 界面保留「收藏原文 / AI 整理」；未保存的结果可直接删除，历史列表也提供删除入口。
- API / Worker 镜像：`petrichor-api:capture-20260922-v2`，镜像 ID `sha256:2bb0f44ea1f8cd110706bd9aec4725d5eed939e50cf037c5b5793eac1b168ac7`。
- Web 镜像：`petrichor-web:capture-20260922-v2`，镜像 ID `sha256:ffc30dd78b031a0dc1e621aa7024cef88134c4d0203955505b65bdc9d0239917`。
- 用户明确批准后执行迁移 `202609220002`，只新增可空的 `deleted_at` 列，耗时约 2.4ms；没有自动删除或批量更新采集内容。
- 保留原配置、Caddy、数据库、Redis、浏览器工具服务、沙箱和数据卷；仅更新 API、Worker、Web 镜像。

## 验证

- 本地相关前端测试 7 个文件、24 项用例通过；TypeScript、定向 ESLint、生产构建及文件行数检查通过。
- 采集、随笔、路由相关 Go 测试和 vet 通过；隔离 PostgreSQL 测试验证用户隔离、来源保护、保存与删除并发、额度保留及 Worker 防复活。
- 桌面和 390px 手机演示模式验证删除确认、取消、删除后退出预览与列表移除，未操作真实用户采集数据。
- 生产 API 健康，API / Worker / Web 均运行且重启计数为 0；上线后日志未发现 panic、fatal 或 error 级别记录。
- 公网 `/`、`/healthz`、`/readyz` 返回 200；未登录调用新删除接口返回 401。
- 公网首页和包含删除接口的 JS 资源 SHA-256 均与运行中 Web 镜像一致。
- 在生产站点的演示模式完成采集预览与确认删除，验证返回网址输入区、预览和历史记录消失。
- 未使用真实 Firecrawl 或模型发起付费验收请求。

## 备份与回滚

以下路径位于服务器，只有 root 可访问：

- 发布源码、变更清单、构建及部署日志：`/opt/petrichor/releases/capture-20260922-v2`。
- 实际业务库 `petrichor_live_20260920` 的 PostgreSQL dump、原 Compose、配置与旧镜像 ID：`/opt/petrichor/backups/capture-20260922-v2`。已验证 dump 目录包含采集表、来源关系及迁移记录。
- 回滚脚本：`/opt/petrichor/releases/capture-20260922-v2/rollback.sh`。恢复上版镜像与 Compose override，不还原数据库、不删除数据卷。新增列会保留；旧版尚不识别删除标记，回滚后已隐藏的采集记录可能重新出现在列表中。

构建仍有已有依赖外部化、dashjs 模块格式及大 chunk 提示，未影响构建完成。
