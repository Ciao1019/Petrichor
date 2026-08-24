export { publicQaChat as POST } from "@/server/kb/public-qa-handlers"

// 长流式响应：与后台问答一致放宽到 300s。
export const maxDuration = 300
