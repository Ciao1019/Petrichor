# 数据库迁移

数据库迁移由运维人员显式执行，不绑定任何托管平台或前端构建流程。

## 工作方式

- `docs/migrations/manifest.json` 是唯一自动执行清单，历史回滚和删除脚本不会被目录扫描误执行。
- `petrichor_schema_migration` 记录文件名、SHA-256、执行时间和完成时间。
- PostgreSQL transaction advisory lock 保证并发部署不会同时迁移。
- 清单中的待执行迁移在同一事务内运行；任一语句失败会整体回滚。
- 已执行文件的校验和变化会阻止继续迁移。不要修改旧迁移，应新增一个后续迁移。

## 新增迁移

1. 在 `docs/migrations/` 新增按日期命名的 `.sql` 文件。
2. 把文件按升序登记到 `docs/migrations/manifest.json`。
3. 本地执行测试和类型检查，然后提交 SQL 与清单。
4. 在目标环境发布前显式执行 `bun run db:migrate`。

自动迁移必须能在 PostgreSQL 事务内运行。`CREATE INDEX CONCURRENTLY` 等不能在事务内
执行的操作，需要拆成专门的人工运维步骤，不得直接登记到自动迁移清单。

## 配置

迁移执行器读取 `apps/api/config.toml`。它优先使用 `[database].migration_url`，
留空时回退到 `[database].url`；Web 环境文件不保存数据库连接串。

## 命令

```bash
# 在本地或目标运维环境执行全部待处理迁移
bun run db:migrate
```
