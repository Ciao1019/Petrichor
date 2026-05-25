import { badRequest } from "@/server/http/response"
import type { AiModelConfigRecord } from "@/server/db/schema"
import { decryptText, encryptText } from "@/server/crypto/spring-text-encryptor"

export type AiConfigType = "CHAT"
export type AiProtocol = "GEMINI" | "OPENAI" | "DEEPSEEK" | "OPENAI_COMPAT" | "SILICONFLOW"

const defaultEncryptKey = "Ek4EhsOIVMQZ2gMAuJXJzUPjCZOjyKIt"
const defaultEncryptSalt = "57da7a247bba15d0"

export interface AiConfigCreateInput {
    configType: AiConfigType
    protocol: AiProtocol
    name: string
    baseUrl: string | null
    apiKey: string | null
    model: string
    enabled: boolean
    isDefault: boolean
    extraJson: string | null
}

export function validateAiConfigCreateInput(raw: unknown): AiConfigCreateInput {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const configType = parseConfigType(value.configType)
    const protocol = parseProtocol(value.protocol)
    const name = String(value.name ?? "").trim()
    const model = String(value.model ?? "").trim()
    const enabled = value.enabled == null ? true : Boolean(value.enabled)
    const apiKey = optionalString(value.apiKey)

    if (!configType) {
        throw badRequest("配置类型不能为空")
    }
    if (!protocol) {
        throw badRequest("协议类型不能为空")
    }
    const baseUrl = applyDefaultBaseUrl(protocol, optionalString(value.baseUrl))
    if (!name) {
        throw badRequest("配置名称不能为空")
    }
    if (!model) {
        throw badRequest("模型名称不能为空")
    }
    if (protocol === "OPENAI_COMPAT" && !baseUrl) {
        throw badRequest("OPENAI_COMPAT 协议必须填写 BaseUrl")
    }
    if (enabled && !apiKey) {
        throw badRequest("启用配置前必须填写 API Key")
    }

    return {
        configType,
        protocol,
        name,
        baseUrl,
        apiKey,
        model,
        enabled,
        isDefault: Boolean(value.isDefault),
        extraJson: optionalString(value.extraJson),
    }
}

export function validateAiConfigIdInput(raw: unknown) {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
    const id = String(value.id ?? "").trim()
    if (!/^\d+$/.test(id)) {
        throw badRequest("配置ID非法")
    }
    return { id: Number(id) }
}

export function parseConfigType(raw: unknown): AiConfigType | null {
    const value = String(raw ?? "").trim()
    return value === "CHAT" ? value : null
}

export function parseProtocol(raw: unknown): AiProtocol | null {
    const value = String(raw ?? "").trim()
    return value === "OPENAI"
        || value === "DEEPSEEK"
        || value === "OPENAI_COMPAT"
        || value === "SILICONFLOW"
        || value === "GEMINI"
        ? value
        : null
}

export function applyDefaultBaseUrl(protocol: AiProtocol, baseUrl: string | null) {
    if (baseUrl) {
        return baseUrl.trim().replace(/\/+$/, "")
    }
    if (protocol === "OPENAI") {
        return "https://api.openai.com/v1"
    }
    if (protocol === "DEEPSEEK") {
        return "https://api.deepseek.com/v1"
    }
    if (protocol === "SILICONFLOW") {
        return "https://api.siliconflow.cn/v1"
    }
    return null
}

export function encodeApiKey(apiKey: string) {
    const { key, salt } = getApiKeyCryptoSettings()
    return encryptText(key, salt, apiKey)
}

export function decodeApiKey(encoded: string | null | undefined) {
    const value = encoded?.trim() ?? ""
    if (!value) {
        return ""
    }
    const { key, salt } = getApiKeyCryptoSettings()
    return decryptText(key, salt, value)
}

export function maskApiKey(apiKey: string) {
    const value = apiKey.trim()
    if (!value) {
        return null
    }
    if (value.length <= 8) {
        return "********"
    }
    return `${value.slice(0, 4)}********${value.slice(-4)}`
}

export function buildAiConfigResponse(config: AiModelConfigRecord) {
    const plainKey = decodeApiKey(config.apiKeyEnc)
    return {
        id: String(config.id),
        configType: config.configType,
        protocol: config.protocol,
        name: config.name,
        baseUrl: config.baseUrl,
        hasApiKey: Boolean(plainKey),
        apiKeyMasked: plainKey ? maskApiKey(plainKey) : null,
        model: config.model,
        enabled: config.enabled,
        isDefault: config.isDefault,
        extraJson: config.extraJson,
        createdAt: formatDate(config.createdAt),
        updatedAt: formatDate(config.updatedAt),
    }
}

export function optionalString(raw: unknown) {
    const value = String(raw ?? "").trim()
    return value || null
}

function formatDate(value: Date | string) {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function getApiKeyCryptoSettings() {
    return {
        key: process.env.PETRICHOR_ENCRYPT_KEY?.trim() || process.env.AI_CONFIG_ENCRYPT_KEY?.trim() || defaultEncryptKey,
        salt: process.env.PETRICHOR_ENCRYPT_SALT?.trim() || process.env.AI_CONFIG_ENCRYPT_SALT?.trim() || defaultEncryptSalt,
    }
}
