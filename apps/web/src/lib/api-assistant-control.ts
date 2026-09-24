import { api } from "@/lib/api-client"

export interface AssistantRecoveryState {
  running: boolean
  available: boolean
  needsReview?: boolean
}

export const assistantControlApi = {
  recovery: (threadId: string) => api.post<AssistantRecoveryState>("/assistant/run/recovery", { threadId }),
  send: (threadId: string, mode: "steer" | "follow_up" | "cancel", text = "") =>
    api.post<{ accepted: boolean }>("/assistant/run/control", { threadId, mode, text }),
}
