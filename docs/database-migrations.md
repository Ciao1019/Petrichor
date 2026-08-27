# 数据库初始化与迁移

数据库完全由 Go 和 Goose 管理，与 Bun、Web 构建和前端环境变量无关。

## 当前基线

`apps/api/migrations/202608270002_init.sql` 是当前唯一的 SQL 文件，包含：

- PostgreSQL 扩展和完整表结构；
- 当前索引、约束和最终字段；
- 只面向全新数据库的最终结构，不包含历史迁移、兼容回填和废弃对象清理；
- 默认超级管理员账号。

Go API 在监听端口前自动执行 `provider.Up`。Goose 通过 `goose_db_version` 判断该基线是否
已经应用；成功后记录版本，失败则回滚事务并终止 API 启动。

## 默认管理员

```text
账号：admin@petrichor.local
密码：Petrichor@2026
```

密码使用 bcrypt 保存。默认明文凭据公开，仅用于首次登录，登录后必须立即修改。

## 配置

执行器读取 `apps/api/config.toml`，优先使用 `[database].migration_url`，留空时回退到
`[database].url`。Supabase transaction pooler 下使用 pgx `QueryExecModeExec`。

## 手动诊断命令

正常启动不需要手动迁移。排查时可以在 `apps/api` 下执行：

```bash
go run ./cmd/migrate status
go run ./cmd/migrate version
go run ./cmd/migrate up
```

## 后续结构变更

当前基线一旦在数据库执行就不可修改。后续结构调整必须新增更高版本的
`<纯数字版本>_<名称>.sql`，并加入 `-- +goose Up`。每个文件默认在独立事务中执行；
`CREATE INDEX CONCURRENTLY` 等不能放入事务的操作应作为单独运维步骤处理。
