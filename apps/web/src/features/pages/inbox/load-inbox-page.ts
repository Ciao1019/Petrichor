export function loadInboxPage() {
  // 路由开始加载时就下载编辑器，与页面代码和接口请求并行。
  // 预加载失败交给实际渲染时的错误边界处理。
  void import("@/components/plate/PlateMarkdownEditor").catch(() => undefined)
  return import("./InboxPage").then((module) => ({ default: module.InboxPage }))
}
