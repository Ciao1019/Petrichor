# Bun / Vite 性能与构建说明

## 构建

前端由 Vite 生成到 `apps/web/dist`，生产请求统一进入根目录 `server.ts` 的
`Bun.serve()`。静态资源文件名带内容哈希，Bun 服务为 `/assets/` 设置长期不可变缓存；
SPA HTML 使用 `no-cache`，便于部署后及时拿到新的资源入口。

```bash
bun run build
bun run start
```

当前应用包含编辑器、PDF、表格、图表和语法高亮等重型模块，生产构建会报告较大的
客户端 chunk。新增重型能力时优先使用动态 `import()`，并避免把服务端模块导入浏览器入口。

## 服务端缓存

- 配置 `UPSTASH_REDIS_REST_URL` 与 `UPSTASH_REDIS_REST_TOKEN` 时，多实例共享缓存。
- 未配置 Redis 时，Bun 进程使用内存 TTL 缓存；实例重启或扩缩容时缓存自然丢失。
- 写操作必须调用对应的失效函数，同时清理本地与 Redis 缓存。

## 验证

```bash
bun run typecheck
bun run test
bun run lint
bun run build
```

部署前还应访问 `/healthz`，确认返回的 `runtime` 为 `bun`，并检查首页、登录页、
公开文章页和至少一个需要登录的 API。
