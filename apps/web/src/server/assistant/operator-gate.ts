import { isSuperAdmin } from "@/server/admin/logic"
import { forbidden } from "@/server/http/response"

export type AssistantOperatorUser = {
    id: number
    systemRole: string | null | undefined
}

/** 本栈唯一门闩；当前实现 = isSuperAdmin。日后改策略只改此处。 */
export function isAssistantOperator(user: AssistantOperatorUser): boolean {
    return isSuperAdmin(user.systemRole, user.id)
}

export function assertAssistantOperator(user: AssistantOperatorUser): void {
    if (!isAssistantOperator(user)) {
        throw forbidden("assistant_operator_only")
    }
}
