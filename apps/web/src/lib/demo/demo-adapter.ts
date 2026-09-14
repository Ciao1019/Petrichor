import axios, { type AxiosAdapter, type AxiosError, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from "axios"

import { isDemoMode, isDemoOnlyBuild } from "./demo-mode"

/*
 * 演示模式的 axios 适配层。
 * 挂在 lib/api.ts 的实例上；非演示模式时原样走真实网络，零成本。
 * 演示模式下把请求路由到内存 mock handlers（动态 import，普通访客不载入 fixtures），
 * 未覆盖的接口返回 400 + 提示（绝不返回 401，避免被登录重定向拦截器踢走）。
 */

export interface DemoHandlerResult {
    status?: number
    data: unknown
}

export type DemoHandler = (body: Record<string, unknown>) => DemoHandlerResult

// 只登记一次性凭据，不读取、复制或保存文件内容，也不生成可联网的上传地址。
const pendingUploads = new Map<string, string>()
export function createDemoUpload(filename: string) {
    if (!isDemoMode()) throw new Error("演示上传仅在演示模式可用")
    const token = crypto.randomUUID()
    const presignedUrl = `demo-upload:${token}`
    const objectKey = `demo/uploads/${token}/${filename}`
    pendingUploads.set(presignedUrl, objectKey)
    return { presignedUrl, objectKey }
}

/** 上传传输层的内存适配；演示状态或凭据异常时失败关闭，绝不回退到真实 PUT。 */
export function completeDemoUpload(presignedUrl: string, objectKey: string, signal?: AbortSignal, onProgress?: (value: number) => void): boolean {
    if (!isDemoMode() && !presignedUrl.startsWith("demo-upload:")) return false
    signal?.throwIfAborted()
    if (!isDemoMode() || pendingUploads.get(presignedUrl) !== objectKey) {
        throw new Error("演示上传凭据无效，请重新选择文件；演示模式不会上传真实文件")
    }
    pendingUploads.delete(presignedUrl)
    onProgress?.(100)
    return true
}

function parseBody(config: InternalAxiosRequestConfig): Record<string, unknown> {
    const raw = config.data
    if (raw == null) return {}
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw)
            return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
        } catch {
            return {}
        }
    }
    return typeof raw === "object" ? (raw as Record<string, unknown>) : {}
}

/** GET 的筛选值位于 config.params；统一合并后 handler 无需关心请求方法。 */
function parseInput(config: InternalAxiosRequestConfig): Record<string, unknown> {
    const params = config.params && typeof config.params === "object"
        ? (config.params as Record<string, unknown>)
        : {}
    return { ...params, ...parseBody(config) }
}

/** 去掉 baseURL 前缀与 query，得到 handlers 表用的路由键，如 "POST /kb/node/tree"。 */
function routeKey(config: InternalAxiosRequestConfig): string {
    const method = (config.method || "get").toUpperCase()
    let url = config.url || ""
    if (url.startsWith("/api/")) url = url.slice(4)
    const queryIndex = url.indexOf("?")
    if (queryIndex >= 0) url = url.slice(0, queryIndex)
    return `${method} ${url}`
}

function buildResponse(config: InternalAxiosRequestConfig, status: number, data: unknown): AxiosResponse {
    return {
        data,
        status,
        statusText: status === 200 ? "OK" : "Error",
        headers: {},
        config,
    }
}

/** 60–160ms 的伪延迟，让加载态/骨架屏走一遍，观感接近真实网络。 */
function demoLatency() {
    return new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100))
}

/* 演示标记开着时，公开站接口与真实登录动作仍然直通网络：
   访客可能从演示模式切回博客 / 关于页，甚至直接去登录，这些都不该被 mock 挡住。 */
function isPassthroughRoute(config: InternalAxiosRequestConfig): boolean {
    // 独立演示构建严禁触网，公开页、初始化状态和登录入口也全部走假数据。
    if (isDemoOnlyBuild()) return false
    let url = config.url || ""
    if (url.startsWith("/api/")) url = url.slice(4)
    return (
        url.startsWith("/public/") ||
        url.startsWith("/auth/setup") ||
        url.startsWith("/auth/login") ||
        url.startsWith("/auth/register") ||
        url.startsWith("/auth/linuxdo")
    )
}

export function installDemoAdapter(instance: AxiosInstance) {
    // 测试环境会整体 mock axios，create() 返回的实例没有 defaults——直接跳过安装
    if (!instance?.defaults) return
    const original = instance.defaults.adapter

    const demoAdapter: AxiosAdapter = async (config) => {
        if (!isDemoMode() || isPassthroughRoute(config)) {
            return axios.getAdapter(original)(config)
        }

        const { resolveDemoHandler } = await import("./demo-handlers")
        const handler = resolveDemoHandler(routeKey(config))
        await demoLatency()

        if (!handler) {
            const response = buildResponse(config, 400, {
                code: 400,
                msg: "演示模式暂不支持此操作，部署自己的实例即可解锁",
            })
            const error = new Error("demo mode: unsupported operation") as AxiosError
            error.isAxiosError = true
            error.config = config
            error.response = response
            throw error
        }

        const result = handler(parseInput(config))
        const status = result.status ?? 200
        const response = buildResponse(config, status, result.data)
        if (status >= 400) {
            const error = new Error("demo mode: handler error") as AxiosError
            error.isAxiosError = true
            error.config = config
            error.response = response
            throw error
        }
        return response
    }

    instance.defaults.adapter = demoAdapter
}
