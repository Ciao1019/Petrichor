// 兼容入口：业务实现按领域拆分，调用方继续从 @/lib/api 导入。
export * from "@/lib/api-client"
export * from "@/lib/api-core"
export * from "@/lib/api-knowledge"
export * from "@/lib/api-wiki"
export * from "@/lib/api-ai"
export * from "@/lib/api-assistant-control"
export * from "@/lib/api-public"
export * from "@/lib/api-public-selection"
export * from "@/lib/api-workspace"
export * from "@/lib/api-inbox"

export * from "./api-capture"
