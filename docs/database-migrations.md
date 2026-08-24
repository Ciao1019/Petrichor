# 数据库自动迁移

Vercel production 部署会先执行数据库增量迁移，成功后才开始 Next.js 构建。
Preview 和 Development 部署默认跳过迁移，避免预览分支误改生产数据库。

## 工作方式

- `docs/migrations/manifest.json` 是唯一自动执行清单，历史回滚和删除脚本不会被目录扫描误执行。
- `petrichor_schema_migration` 记录文件名、SHA-256、执行时间和完成时间。
- PostgreSQL transaction advisory lock 保证并发部署不会同时迁移。
- 清单中的待执行迁移在同一事务内运行；任一语句失败会整体回滚并阻止部署。
- 已执行文件的校验和变化会阻止部署。不要修改旧迁移，应新增一个后续迁移。

## 新增迁移

1. 在 `docs/migrations/` 新增按日期命名的 `.sql` 文件。
2. 把文件按升序登记到 `docs/migrations/manifest.json`。
3. 本地执行测试和类型检查，然后提交 SQL 与清单。
4. 合并到生产分支后，Vercel 自动执行尚未执行的文件。

自动迁移必须能在 PostgreSQL 事务内运行。`CREATE INDEX CONCURRENTLY` 等不能在事务内
执行的操作，需要拆成专门的人工运维步骤，不得直接登记到自动迁移清单。

## 环境变量

Vercel Production 环境至少需要 `DATABASE_URL`。建议额外配置
`MIGRATION_DATABASE_URL`，使用数据库直连或 session pooler 连接；迁移执行器会优先使用它。
该变量只用于构建期迁移，不会暴露给浏览器。

## 命令

```bash
# 本地/运维环境执行全部待处理迁移
DATABASE_URL=... bun db:migrate

# Vercel 构建入口；非 production 环境会跳过迁移
VERCEL_ENV=production DATABASE_URL=... bun vercel-build
```
