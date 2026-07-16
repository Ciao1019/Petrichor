# Attention

本文件是 CodeStable 技能启动必读的项目注意事项入口。所有 CodeStable 子技能开始工作前必须读取它。

## 项目碎片知识

<!-- cs-note managed: 用 cs-note 维护，新条目按下面分节追加 -->

### 编译与构建

### 运行与本地起服务

- Next.js 16 禁止在同一目录（apps/web）起第二个 dev server：第二个实例直接退出并提示 kill 旧 PID——先 kill 旧实例再起新的
- 站内对话唯一入口是 `/dashboard/assistant`；旧知识/文档问答、Agent 记忆页已下线（表结构保留不 DROP）
- 前台公开问答入口是 `/ask`：仅索引永久公开分享且无密码的文章；站点开关 `publicQaEnabled`；访客限流 visitor 10/h + IP 60/h

### 测试

### 命令与脚本陷阱

### 路径与目录约定

### 环境变量与凭证

### 其他

- Assistant 危险确认票据表：`docs/migrations/2026-07-16-assistant-confirmation-ticket.sql`；未跑迁移则确认危险操作会失败
- 助手工具装载对齐 Claude Code：`system+knowledge+doc_library+content_write` 常驻；`admin` 按需；dangerous 仍走确认协议，不靠意图藏普通写工具
