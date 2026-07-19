/*
 * 演示模式开关。
 * 访客从 /demo 进入 → sessionStorage 落一个标记 → 复用真实 /dashboard 页面，
 * 但所有 API 被 demo adapter 拦截到内存 mock store（见 demo-adapter.ts）。
 * 刷新页面 = 内存 store 重建 = 数据重置；关闭标签页 = 演示结束。
 */

const DEMO_FLAG_KEY = "petrichor-demo-mode"

export function isDemoMode(): boolean {
    if (typeof window === "undefined") return false
    try {
        return window.sessionStorage.getItem(DEMO_FLAG_KEY) === "1"
    } catch {
        return false
    }
}

export function enterDemoMode() {
    try {
        window.sessionStorage.setItem(DEMO_FLAG_KEY, "1")
    } catch {
        // sessionStorage 不可用（隐私模式等）时演示模式静默失效
    }
}

/** 退出演示：清标记并整页跳走，顺带丢弃内存 mock store。 */
export function exitDemoMode(target = "/petrichor") {
    try {
        window.sessionStorage.removeItem(DEMO_FLAG_KEY)
    } catch {
        // 忽略
    }
    window.location.href = target
}
