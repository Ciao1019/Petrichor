import { createContext } from "react"

export const AssistantResumeContext = createContext<() => void>(() => {})

// 一次性恢复标记只在事件和网络回调之间传递，不参与渲染。
export function createResumeRequest() {
  let requested = false
  return {
    request() { requested = true },
    consume() { const value = requested; requested = false; return value },
  }
}
