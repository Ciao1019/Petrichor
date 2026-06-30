/**
 * 📊 结构化日志工具
 *
 * 轻量 console 实现，保持与 pino 兼容的调用签名（debug/info/warn/error/child）。
 * 不依赖任何外部包，可在 Node / Edge / 浏览器等所有运行时安全使用，
 * 也不会被打进 RSC / 页面 bundle 造成解析失败。
 */

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
}

const isDevelopment = process.env.NODE_ENV === "development"
const configuredLevel = (process.env.LOG_LEVEL as LogLevel | undefined) ?? (isDevelopment ? "debug" : "info")
const minPriority = LEVEL_PRIORITY[configuredLevel] ?? LEVEL_PRIORITY.info

type LogFn = (objOrMsg: unknown, msg?: string, ...args: unknown[]) => void

export interface Logger {
    trace: LogFn
    debug: LogFn
    info: LogFn
    warn: LogFn
    error: LogFn
    fatal: LogFn
    child: (bindings: Record<string, unknown>) => Logger
}

function jsonReplacer(_key: string, value: unknown) {
    if (value instanceof Error) {
        return { type: value.name, message: value.message, stack: value.stack }
    }
    return value
}

function consoleFor(level: LogLevel) {
    if (level === "error" || level === "fatal") return console.error
    if (level === "warn") return console.warn
    if (level === "trace" || level === "debug") return console.debug
    return console.info
}

function createLoggerInstance(bindings: Record<string, unknown>): Logger {
    const make = (level: LogLevel): LogFn => (objOrMsg, msg, ...args) => {
        if (LEVEL_PRIORITY[level] < minPriority) {
            return
        }
        const record: Record<string, unknown> = { level, time: Date.now(), ...bindings }
        if (typeof objOrMsg === "string") {
            record.msg = objOrMsg
        } else if (objOrMsg && typeof objOrMsg === "object") {
            Object.assign(record, objOrMsg)
            if (msg) {
                record.msg = msg
            }
        } else if (objOrMsg !== undefined) {
            record.msg = String(objOrMsg)
        }
        if (args.length > 0) {
            record.args = args
        }
        consoleFor(level)(JSON.stringify(record, jsonReplacer))
    }

    return {
        trace: make("trace"),
        debug: make("debug"),
        info: make("info"),
        warn: make("warn"),
        error: make("error"),
        fatal: make("fatal"),
        child: (childBindings) => createLoggerInstance({ ...bindings, ...childBindings }),
    }
}

export const logger = createLoggerInstance({})

// 导出子 logger 创建函数
export const createLogger = (name: string) => {
    return logger.child({ name })
}

// 性能测量工具
export const measurePerformance = <T>(
    name: string,
    fn: () => T | Promise<T>
): Promise<T> => {
    const start = performance.now()
    const log = createLogger("performance")

    const finish = (result: T) => {
        const duration = performance.now() - start
        log.info({ operation: name, duration: `${duration.toFixed(2)}ms` })
        return result
    }

    try {
        const result = fn()
        if (result instanceof Promise) {
            return result.then(finish)
        }
        return Promise.resolve(finish(result))
    } catch (error) {
        const duration = performance.now() - start
        log.error({
            operation: name,
            duration: `${duration.toFixed(2)}ms`,
            error: error instanceof Error ? error.message : String(error),
        })
        throw error
    }
}
