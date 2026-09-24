# 设置入口回归左侧菜单

2026-09-22 已部署至 <https://wl.do>，当前发布版本 `sidebar-20260922-v2`。

## 调整

- 模型配置、数据概览直接显示在左侧「常用设置」。
- Agent 集成、系统管理默认收起；系统管理按权限显示，访问组内页面时自动展开。
- 账号设置固定在侧栏底部；设置页面移除原来的分类与页面两层顶部导航。
- 面包屑与侧栏一致；手机端选择页面后收起菜单，图标模式保留所有入口。折叠触发器支持键盘，隐藏内容不进入 Tab 顺序。
- 仅修改 `app-sidebar.tsx`、`nav-content.tsx`、`app-breadcrumb.tsx`、`SettingsLayout.tsx`，沿用现有 Sidebar、Radix Collapsible 和图标，无新增依赖。

## 验证与发布

- 既有导航测试 2 个文件、8 项用例通过；TypeScript、定向 ESLint、生产构建及 800 行限制检查通过。
- 浏览器检查 1440px 桌面和 390px 手机、明暗主题、当前页面高亮、键盘展开、侧栏图标模式与手机端自动关闭；检查的导航流程无控制台错误。
- Web 镜像：`petrichor-web:sidebar-20260922-v1`，ID `sha256:f74c679f95b1ec924dd7574117b78ce7e7dc9eaa32aa8dd8bb36e3f8f34a667a`。
- 以线上 `capture-20260922-v2` 为基础叠加这 4 个文件，仅更新 Web；API / Worker 继续使用采集删除功能版本，没有数据库变更。
- 公网首页、健康检查均返回 200，首页 hash 与新镜像一致；上线后 Web 重启计数为 0。
- 构建保留既有依赖外部化、dashjs 模块格式及大 chunk 提示。

服务器发布与日志：`/opt/petrichor/releases/sidebar-20260922-v1`。
备份：`/opt/petrichor/backups/sidebar-20260922-v1`。
回滚：运行发布目录内 `rollback.sh`，恢复上一版 Compose override 与 Web 镜像。

## v2：恢复默认折叠与动画

- 移除 Agent 集成的默认展开，恢复分组展开与收起的 0.24 秒高度、透明度动画；整条侧栏保留 0.42 秒宽度动画。
- 沿用现有 GSAP，保留关闭时的 DOM 以完成收起动画；关闭内容设置 `inert`、`aria-hidden`，不进入键盘访问顺序。
- 快速反向点击从当前高度继续，展开结束恢复自动高度；页面加载时开启减少动态效果偏好会直接切换终态。
- 仅叠加 `app-sidebar.tsx`、`nav-content.tsx`、`ui/gsap-collapse.tsx`，无新增依赖、数据库变更。
- TypeScript、定向 ESLint、既有导航测试（8 项）、生产构建及文件行数检查通过。
- 浏览器实测分组高度 0 → 176px 与逆向中间帧，侧栏宽度 224 → 66px 与逆向中间帧；快速反向点击终态正确。390px 手机端默认折叠、导航后关闭菜单、1440px 减少动态效果模式及活动分组自动展开均通过，验收流程无控制台错误。
- 线上演示页确认 Agent 集成默认收起，展开动画存在连续中间帧，无控制台错误；系统管理的管理员入口在本地演示环境验证。
- Web 镜像：`petrichor-web:sidebar-20260922-v2`，ID `sha256:e2bf06c792c12eae25e9ea0c8c4a5b56b84d187723e5b7ab5fe5f6c1ddf4ffc8`。
- 仅更新 Web，容器健康、重启计数 0；API / Worker 版本与启动时间均未改变。
- 公网 `/`、`/healthz`、`/readyz` 均返回 200；公网首页与容器内文件 SHA256 一致：`b2e3110f84fcce77a8afc202e25ad429e9d24a08beaecb661f5db894afdc293f`。

当前发布与日志：`/opt/petrichor/releases/sidebar-20260922-v2`。
备份：`/opt/petrichor/backups/sidebar-20260922-v2`。
回滚：运行当前发布目录的 `rollback.sh`，恢复 v1 Web 镜像。
