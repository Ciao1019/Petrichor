import { badRequest } from "@/server/http/response"

export type RegisterDefaultSystemRole = "USER" | "SUPER_ADMIN"

export const REGISTER_DEFAULT_SYSTEM_ROLE_ENV = "PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE"

export function resolveRegisterDefaultSystemRole(
    env: Record<string, string | undefined> = process.env,
): RegisterDefaultSystemRole {
    const raw = env[REGISTER_DEFAULT_SYSTEM_ROLE_ENV]?.trim().toUpperCase()
    if (!raw) {
        return "USER"
    }
    if (raw === "USER" || raw === "SUPER_ADMIN") {
        return raw
    }

    throw badRequest(`${REGISTER_DEFAULT_SYSTEM_ROLE_ENV} 只支持 USER 或 SUPER_ADMIN`)
}
