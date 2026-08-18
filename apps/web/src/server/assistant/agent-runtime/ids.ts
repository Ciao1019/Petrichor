import { randomUUID } from "node:crypto"

/** 统一 id 生成，便于测试注入与 trace 关联 */
export function newId(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`
}

export function newRunId(): string {
    return newId("run")
}
