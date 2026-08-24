# 🚀 性能优化指南

本文档记录了项目中实施的各项性能优化措施和最佳实践。

## 📦 已实施的优化

### 1. 构建优化 (next.config.ts)

- ✅ **包导入优化**: 使用 `optimizePackageImports` 减少重复代码
- ✅ **CSS 优化**: 启用 `optimizeCss` 减少客户端 JavaScript
- ✅ **图片优化**: 支持 AVIF/WebP 格式，设置长期缓存
- ✅ **代码分割**: 为 PlateJS、Radix UI、图标库等大型依赖单独打包
- ✅ **安全头**: 配置 X-Frame-Options, CSP 等安全响应头

### 2. 数据库优化

**性能监控工具** (`src/server/db/performance.ts`):
- `explainQuery()` - EXPLAIN ANALYZE 查询分析
- `withQueryTiming()` - 自动记录查询耗时，超过 100ms 发出警告
- `checkIndexUsage()` - 检查索引使用情况

**使用示例**:
```typescript
import { withQueryTiming } from '@/server/db/performance'

const articles = await withQueryTiming(
  'getPublicArticles',
  () => db.select().from(articles).where(eq(articles.isPublic, true))
)
```

### 3. React 组件性能

**自定义 Hooks** (`src/hooks/use-performance.ts`):
- `useDebounce` - 防抖处理
- `useThrottle` - 节流处理
- `useIntersectionObserver` - 懒加载支持
- `useVirtualList` - 虚拟滚动列表
- `useMediaQuery` - 响应式媒体查询
- `useDeferredRender` - 延迟渲染

**使用示例**:
```tsx
import { useDebounce, useIntersectionObserver } from '@/hooks/use-performance'

// 搜索输入防抖
const debouncedSearch = useDebounce(searchTerm, 300)

// 图片懒加载
const ref = useRef<HTMLImageElement>(null)
const isVisible = useIntersectionObserver(ref, { threshold: 0.1 })
```

### 4. API 速率限制

**速率限制工具** (`src/lib/rate-limit.ts`):
- 内存存储实现（生产环境建议使用 Redis）
- 自动清理过期记录
- 预设配置：strict / moderate / lenient

**Route Handler 包装器** (`src/lib/with-rate-limit.ts`):
```typescript
import { withRateLimit, rateLimitPresets } from '@/lib/with-rate-limit'

export const POST = withRateLimit(
  async (req) => {
    // 你的 API 逻辑
    return NextResponse.json({ success: true })
  },
  rateLimitPresets.strict // 15 分钟 5 次
)
```

### 5. 日志系统

**结构化日志** (`src/lib/logger.ts`):
- 使用 pino 替代 console.log
- 开发环境：彩色格式化输出
- 生产环境：JSON 格式便于收集
- 性能测量工具

**使用示例**:
```typescript
import { createLogger, measurePerformance } from '@/lib/logger'

const logger = createLogger('my-module')
logger.info({ userId: 123, action: 'login' }, 'User logged in')

await measurePerformance('processArticle', async () => {
  // 耗时操作
})
```

### 6. 输入验证

**Zod Schema 集合** (`src/lib/validation.ts`):
- 文章、文件夹、用户认证等完整的验证 Schema
- 类型安全的输入验证
- 详细的错误消息

**使用示例**:
```typescript
import { createArticleSchema } from '@/lib/validation'

const result = createArticleSchema.safeParse(requestBody)
if (!result.success) {
  return NextResponse.json({ errors: result.error.errors }, { status: 400 })
}
```

## 🧪 测试与质量

### 单元测试增强 (vitest.config.ts)

```bash
# 运行测试
bun test

# 带覆盖率报告
bun test:coverage

# 交互式 UI
bun test:ui
```

- ✅ 覆盖率目标：60%+
- ✅ 并发运行测试
- ✅ 多格式报告（text/json/html/lcov）

### E2E 测试 (Playwright)

```bash
# 安装浏览器
bunx playwright install

# 运行 E2E 测试
bunx playwright test

# 查看报告
bunx playwright show-report
```

- ✅ 多浏览器支持（Chrome/Firefox/Safari）
- ✅ 移动端测试
- ✅ 失败时自动截图
- ✅ 示例测试：登录流程、响应式设计

### TypeScript 严格模式 (tsconfig.json)

- ✅ `noUncheckedIndexedAccess` - 数组/对象访问安全检查
- ✅ `noImplicitOverride` - 显式重写标记
- ✅ `noFallthroughCasesInSwitch` - Switch 语句完整性检查

### 代码质量工具 (Biome)

```bash
# 检查代码
bun biome:check

# 自动修复
bun biome:fix
```

- ✅ 比 ESLint 快 50 倍
- ✅ 内置格式化器
- ✅ 自动导入排序

## 📊 Bundle 分析

```bash
# 生成 bundle 分析报告
bun analyze
```

打开 `.next/analyze/client.html` 查看详细的包大小分析。

## 🎯 待优化项

### 高优先级
- [ ] 为热门查询添加 Redis 缓存
- [ ] 数据库索引优化（基于 EXPLAIN ANALYZE 结果）
- [ ] 大型组件懒加载（PlateJS 编辑器、Excalidraw）

### 中优先级
- [ ] PWA 支持（离线访问）
- [ ] 图片 CDN 加速
- [ ] Service Worker 缓存策略
- [ ] 骨架屏加载状态

### 低优先级
- [ ] 预渲染静态页面
- [ ] HTTP/3 支持
- [ ] 前端资源预加载策略

## 📈 性能监控

### 建议集成的工具

1. **Vercel Analytics** (免费)
```bash
bun add @vercel/analytics
```

2. **Sentry 错误追踪**
```bash
bun add @sentry/nextjs
```

3. **Web Vitals 报告**
```typescript
// 在 _app.tsx 或 layout.tsx
import { reportWebVitals } from '@/lib/performance'

reportWebVitals((metric) => {
  console.log(metric)
  // 发送到分析服务
})
```

## 🔧 生产环境清单

部署前确认：

- [ ] `next.config.ts` 中的优化配置已启用
- [ ] 环境变量配置完整
- [ ] 数据库索引已添加
- [ ] API 速率限制已应用到关键端点
- [ ] 安全响应头已配置
- [ ] 日志系统正常工作
- [ ] 错误追踪已集成
- [ ] Bundle 大小在可接受范围（< 250KB gzipped）

## 📚 参考资源

- [Next.js Performance](https://nextjs.org/docs/app/building-your-application/optimizing)
- [React Performance](https://react.dev/learn/render-and-commit#optimizing-performance)
- [Web Vitals](https://web.dev/vitals/)
- [Playwright Testing](https://playwright.dev/)
- [Biome Linter](https://biomejs.dev/)
