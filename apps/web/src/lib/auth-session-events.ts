let generation = 0
const listeners = new Set<() => void>()

export const getAuthSessionGeneration = () => generation

/** 轻量同步事件，不依赖浏览器、React 或业务缓存模块。 */
export function subscribeAuthSessionReset(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 在认证 Promise 交还调用方之前隔离旧会话，防止新页面读到旧缓存。 */
export function resetAuthSession() {
  generation += 1
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 单个订阅者失败不能阻止其他缓存清理，也不能改变认证返回值或错误。
    }
  }
}
