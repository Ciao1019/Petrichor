/**
 * 📊 结构化日志工具
 * 使用 pino 替代 console.log，提供更好的性能和结构化输出
 */

import pino from "pino"

const isDevelopment = process.env.NODE_ENV === "development"

export const logger = pino({
    level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),
    // 开发环境使用漂亮的输出格式
    transport: isDevelopment
        ? {
              target: "pino-pretty",
              options: {
                  colorize: true,
                  translateTime: "SYS:standard",
                  ignore: "pid,hostname",
              },
          }
        : undefined,
    // 生产环境使用 JSON 格式便于日志收集
    formatters: {
        level: (label) => {
            return { level: label }
        },
    },
})

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
