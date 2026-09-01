/**
 * 全局测试环境补齐。
 *
 * jsdom 不实现 ResizeObserver，而 assistant-ui Elements 的 SwapLabel 靠它测量
 * 当前文案宽度做过渡。这是环境缺 API，不是组件缺陷——所以补在这里，而不是往
 * 生产代码里加一层浏览器早就不需要的防御。
 * node 环境的用例同样会加载本文件，但那里没有 globalThis.window，判断直接短路。
 */
if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver
}

/**
 * jsdom 没有 canvas 2D 上下文，thinking-orbs 的点阵球每次挂载都会打一行
 * "Not implemented: HTMLCanvasElement's getContext()"。组件本身能容忍拿不到
 * 上下文（拿不到就不画），这里只是把噪声按掉，不引入 canvas 原生依赖。
 */
if (typeof globalThis.HTMLCanvasElement !== "undefined") {
    globalThis.HTMLCanvasElement.prototype.getContext = (() => null) as unknown as
        typeof globalThis.HTMLCanvasElement.prototype.getContext
}
