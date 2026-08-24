import { createLogger, toLogError } from "@/lib/logger"

const log = createLogger("http-lifecycle")

/** 在响应返回后异步执行任务；Bun 进程会继续持有该 Promise。 */
export function afterResponse(task: () => void | Promise<void>) {
    queueMicrotask(() => {
        void Promise.resolve()
            .then(task)
            .catch((error) => log.error({ err: toLogError(error) }, "响应后任务执行失败"))
    })
}

