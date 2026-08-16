/**
 * AI 模型接入的纯逻辑层：入参校验、加解密、响应构造。
 * 不碰数据库和网络，便于单测覆盖。
 */

import { badRequest } from "@/server/http/response"
import type {
    AiBindingRecord,
    AiCredentialRecord,
    AiModelRecord,
    AiProviderRecord,
} from "@/server/db/schema"
import { decryptText, encryptText } from "@/server/crypto/spring-text-encryptor"
import {
    findProvider,
    resolveApiProtocol,
    resolveBaseUrl,
    supportedApiProtocols,
    type ApiProtocol,
    type ModelCapability,
    type ProviderDefinition,
    type ProviderModelKind,
} from "@/server/ai/provider-catalog"

/** 模型用途。与旧的 configType 同名，语义不变，但不再承担「一条配置」的职责。 */
export type AiPurpose = "CHAT" | "VISION" | "DOC_QA" | "EMBEDDING"

export const AI_PURPOSES: AiPurpose[] = ["CHAT", "VISION", "DOC_QA", "EMBEDDING"]

/** 每个用途需要什么类型的模型 */
export const PURPOSE_MODEL_KIND: Record<AiPurpose, ProviderModelKind> = {
    CHAT: "LANGUAGE",
    VISION: "LANGUAGE",
    DOC_QA: "LANGUAGE",
    EMBEDDING: "EMBEDDING",
}

const defaultEncryptKey = "Ek4EhsOIVMQZ2gMAuJXJzUPjCZOjyKIt"
const defaultEncryptSalt = "57da7a247bba15d0"

// ===== 加解密 =====

export function encodeApiKey(apiKey: string) {
    const { key, salt } = getApiKeyCryptoSettings()
    return encryptText(key, salt, apiKey)
}

export function decodeApiKey(encoded: string | null | undefined) {
    const value = encoded?.trim() ?? ""
    if (!value) return ""
    const { key, salt } = getApiKeyCryptoSettings()
    return decryptText(key, salt, value)
}

/** 额外凭证字段整体序列化后加密 */
export function encodeExtra(extra: Record<string, string>): string | null {
    const entries = Object.entries(extra).filter(([, value]) => value.trim())
    if (entries.length === 0) return null
    return encodeApiKey(JSON.stringify(Object.fromEntries(entries)))
}

export function decodeExtra(encoded: string | null | undefined): Record<string, string> {
    const raw = decodeApiKey(encoded)
    if (!raw) return {}
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!isRecord(parsed)) return {}
        return Object.fromEntries(
            Object.entries(parsed)
                .filter(([, value]) => typeof value === "string")
                .map(([key, value]) => [key, value as string]),
        )
    } catch {
        return {}
    }
}

export function maskApiKey(apiKey: string) {
    const value = apiKey.trim()
    if (!value) return null
    if (value.length <= 8) return "********"
    return `${value.slice(0, 4)}********${value.slice(-4)}`
}

function getApiKeyCryptoSettings() {
    return {
        key: process.env.PETRICHOR_ENCRYPT_KEY?.trim() || process.env.AI_CONFIG_ENCRYPT_KEY?.trim() || defaultEncryptKey,
        salt: process.env.PETRICHOR_ENCRYPT_SALT?.trim() || process.env.AI_CONFIG_ENCRYPT_SALT?.trim() || defaultEncryptSalt,
    }
}

// ===== 通用解析 =====

export function parsePurpose(raw: unknown): AiPurpose | null {
    const value = String(raw ?? "").trim()
    return AI_PURPOSES.includes(value as AiPurpose) ? value as AiPurpose : null
}

export function requirePurpose(raw: unknown): AiPurpose {
    const purpose = parsePurpose(raw)
    if (!purpose) {
        throw badRequest("用途不能为空，应为 CHAT / VISION / DOC_QA / EMBEDDING 之一")
    }
    return purpose
}

export function parseModelKind(raw: unknown): ProviderModelKind | null {
    const value = String(raw ?? "").trim()
    return value === "LANGUAGE" || value === "EMBEDDING" ? value : null
}

export function optionalString(raw: unknown) {
    const value = String(raw ?? "").trim()
    return value || null
}

export function requireId(raw: unknown, label = "ID"): number {
    const value = String(raw ?? "").trim()
    if (!/^\d+$/.test(value)) {
        throw badRequest(`${label}非法`)
    }
    return Number(value)
}

export function parseOptionalId(raw: unknown, label = "ID"): number | null {
    if (raw == null || raw === "") return null
    return requireId(raw, label)
}

/** 解析 JSON 对象字符串，失败返回空对象 */
export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
    const text = raw?.trim()
    if (!text) return {}
    try {
        const parsed = JSON.parse(text) as unknown
        return isRecord(parsed) ? parsed : {}
    } catch {
        return {}
    }
}

/** 把任意入参规整成 string -> string 的字典（自定义请求头、额外凭证字段） */
export function parseStringMap(raw: unknown): Record<string, string> {
    const source = typeof raw === "string" ? parseJsonObject(raw) : isRecord(raw) ? raw : {}
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(source)) {
        const name = key.trim()
        if (!name) continue
        if (typeof value === "string" && value.trim()) {
            result[name] = value.trim()
        }
    }
    return result
}

// ===== 凭证 =====

export interface CredentialInput {
    name: string
    providerKey: string | null
    apiKey: string
    extra: Record<string, string>
}

export function validateCredentialInput(raw: unknown, options: { requireApiKey: boolean }): CredentialInput {
    const value = isRecord(raw) ? raw : {}
    const name = String(value.name ?? "").trim()
    if (!name) {
        throw badRequest("凭证名称不能为空")
    }
    if (name.length > 64) {
        throw badRequest("凭证名称不能超过 64 个字符")
    }

    const providerKeyRaw = optionalString(value.providerKey)
    if (providerKeyRaw && !findProvider(providerKeyRaw)) {
        throw badRequest(`未知的供应商：${providerKeyRaw}`)
    }

    const apiKey = String(value.apiKey ?? "").trim()
    if (options.requireApiKey && !apiKey) {
        throw badRequest("API Key 不能为空")
    }

    return { name, providerKey: providerKeyRaw, apiKey, extra: parseStringMap(value.extra) }
}

export function buildCredentialResponse(record: AiCredentialRecord, usageCount = 0) {
    const plain = decodeApiKey(record.apiKeyEnc)
    const provider = findProvider(record.providerKey)
    return {
        id: String(record.id),
        name: record.name,
        providerKey: record.providerKey,
        providerName: provider?.name ?? null,
        apiKeyMasked: maskApiKey(plain),
        extraKeys: Object.keys(decodeExtra(record.extraEnc)),
        usageCount,
        lastUsedAt: formatDate(record.lastUsedAt),
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

// ===== 供应商实例 =====

export interface ProviderInput {
    providerKey: string
    name: string
    baseUrl: string | null
    credentialId: number
    enabled: boolean
    headers: Record<string, string>
    options: Record<string, unknown>
}

export function validateProviderInput(raw: unknown): ProviderInput {
    const value = isRecord(raw) ? raw : {}
    const providerKey = String(value.providerKey ?? "").trim()
    const provider = findProvider(providerKey)
    if (!provider) {
        throw badRequest("请选择供应商")
    }

    const name = String(value.name ?? "").trim() || provider.name
    if (name.length > 64) {
        throw badRequest("供应商名称不能超过 64 个字符")
    }

    const baseUrl = normalizeBaseUrlInput(value.baseUrl)
    assertBaseUrlSatisfied(provider, baseUrl)

    const credentialId = requireId(value.credentialId, "凭证 ID")

    const options = isRecord(value.options) ? { ...value.options } : parseJsonObject(optionalString(value.options))
    // 协议存成规范值，避免前端传 "Responses"/"" 之类的脏数据流进 optionsJson
    options.apiProtocol = resolveApiProtocol(provider, options.apiProtocol as string | undefined)

    return {
        providerKey,
        name,
        baseUrl,
        credentialId,
        enabled: value.enabled == null ? true : Boolean(value.enabled),
        headers: parseStringMap(value.headers),
        options,
    }
}

/** 用户没填 BaseUrl 时存 null（跟随目录默认值），填了就去掉尾部斜杠 */
export function normalizeBaseUrlInput(raw: unknown): string | null {
    const value = String(raw ?? "").trim().replace(/\/+$/, "")
    return value || null
}

export function assertBaseUrlSatisfied(provider: ProviderDefinition, baseUrl: string | null) {
    if (provider.baseUrlRequired && !resolveBaseUrl(provider, baseUrl)) {
        throw badRequest(`${provider.name} 必须填写 BaseUrl`)
    }
}

/**
 * 供应商实例上生效的语言模型协议。存在 optionsJson.apiProtocol 里，
 * 非法值或该供应商不支持时回落到目录默认值。
 */
export function providerApiProtocol(record: Pick<AiProviderRecord, "providerKey" | "optionsJson">): ApiProtocol {
    const provider = findProvider(record.providerKey)
    if (!provider) return "chat"
    return resolveApiProtocol(provider, parseJsonObject(record.optionsJson).apiProtocol as string | undefined)
}

export function buildProviderResponse(record: AiProviderRecord, extras: {
    credential?: AiCredentialRecord | null
    modelCount?: number
    enabledModelCount?: number
} = {}) {
    const provider = findProvider(record.providerKey)
    return {
        id: String(record.id),
        providerKey: record.providerKey,
        providerName: provider?.name ?? record.providerKey,
        accent: provider?.accent ?? "slate",
        name: record.name,
        baseUrl: record.baseUrl,
        effectiveBaseUrl: provider ? resolveBaseUrl(provider, record.baseUrl) : record.baseUrl,
        supportsModelListing: provider ? provider.listing !== "none" : false,
        kinds: provider?.kinds ?? [],
        apiProtocols: provider ? supportedApiProtocols(provider) : ["chat" as ApiProtocol],
        apiProtocol: providerApiProtocol(record),
        credentialId: String(record.credentialId),
        credentialName: extras.credential?.name ?? null,
        enabled: record.enabled,
        headers: parseStringMap(record.headersJson),
        options: parseJsonObject(record.optionsJson),
        modelCount: extras.modelCount ?? 0,
        enabledModelCount: extras.enabledModelCount ?? 0,
        lastCheckedAt: formatDate(record.lastCheckedAt),
        lastCheckStatus: record.lastCheckStatus,
        lastCheckMessage: record.lastCheckMessage,
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

// ===== 模型 =====

export interface ModelInput {
    modelId: string
    displayName: string | null
    kind: ProviderModelKind
    contextWindow: number | null
    capabilities: ModelCapability[]
    enabled: boolean
}

const VALID_CAPABILITIES: ModelCapability[] = ["tools", "vision", "reasoning", "json"]

export function validateModelInput(raw: unknown): ModelInput {
    const value = isRecord(raw) ? raw : {}
    const modelId = String(value.modelId ?? "").trim()
    if (!modelId) {
        throw badRequest("模型 ID 不能为空")
    }
    const kind = parseModelKind(value.kind)
    if (!kind) {
        throw badRequest("模型类型应为 LANGUAGE 或 EMBEDDING")
    }
    return {
        modelId,
        displayName: optionalString(value.displayName),
        kind,
        contextWindow: positiveIntegerOrNull(value.contextWindow),
        capabilities: parseCapabilities(value.capabilities),
        enabled: value.enabled == null ? true : Boolean(value.enabled),
    }
}

export function parseCapabilities(raw: unknown): ModelCapability[] {
    const source = typeof raw === "string" ? safeParseArray(raw) : raw
    if (!Array.isArray(source)) return []
    return VALID_CAPABILITIES.filter((capability) => source.includes(capability))
}

export function buildModelResponse(record: AiModelRecord, extras: { provider?: AiProviderRecord | null } = {}) {
    return {
        id: String(record.id),
        providerId: String(record.providerId),
        providerName: extras.provider?.name ?? null,
        providerKey: extras.provider?.providerKey ?? null,
        modelId: record.modelId,
        displayName: record.displayName,
        kind: record.kind as ProviderModelKind,
        contextWindow: record.contextWindow,
        // 向量模型的输出维度，null 表示还没探测过
        dimensions: record.dimensions,
        capabilities: parseCapabilities(record.capabilitiesJson),
        enabled: record.enabled,
        createdAt: formatDate(record.createdAt),
        updatedAt: formatDate(record.updatedAt),
    }
}

// ===== 用途绑定 =====

export interface GenerationOptions {
    maxTokens: number | null
    temperature: number | null
    thinking: "enabled" | "disabled" | null
    disableThinkingForTools: boolean
}

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = {
    maxTokens: null,
    temperature: null,
    thinking: null,
    disableThinkingForTools: true,
}

export function parseGenerationOptions(raw: string | Record<string, unknown> | null | undefined): GenerationOptions {
    const parsed = typeof raw === "string" ? parseJsonObject(raw) : raw ?? {}
    return {
        maxTokens: positiveIntegerOrNull(parsed.maxTokens ?? parsed.max_tokens),
        temperature: numberOrNull(parsed.temperature),
        thinking: normalizeThinking(parsed.thinking ?? parsed.deepSeekThinking),
        disableThinkingForTools: booleanOrDefault(parsed.disableThinkingForTools, true),
    }
}

export function buildBindingResponse(record: AiBindingRecord, extras: {
    model?: AiModelRecord | null
    provider?: AiProviderRecord | null
} = {}) {
    return {
        id: String(record.id),
        purpose: record.purpose as AiPurpose,
        modelRefId: String(record.modelRefId),
        modelId: extras.model?.modelId ?? null,
        modelDisplayName: extras.model?.displayName ?? null,
        providerId: extras.provider ? String(extras.provider.id) : null,
        providerName: extras.provider?.name ?? null,
        providerKey: extras.provider?.providerKey ?? null,
        contextWindow: extras.model?.contextWindow ?? null,
        dimensions: extras.model?.dimensions ?? null,
        options: parseGenerationOptions(record.optionsJson),
        updatedAt: formatDate(record.updatedAt),
    }
}

// ===== 小工具 =====

function normalizeThinking(value: unknown): "enabled" | "disabled" | null {
    if (isRecord(value)) return normalizeThinking(value.type)
    if (typeof value === "boolean") return value ? "enabled" : "disabled"
    const text = typeof value === "string" ? value.trim().toLowerCase() : ""
    return text === "enabled" || text === "disabled" ? text : null
}

function booleanOrDefault(value: unknown, defaultValue: boolean) {
    if (typeof value === "boolean") return value
    if (typeof value === "string") {
        const text = value.trim().toLowerCase()
        if (["true", "1", "yes", "on"].includes(text)) return true
        if (["false", "0", "no", "off"].includes(text)) return false
    }
    return defaultValue
}

function positiveIntegerOrNull(value: unknown) {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function numberOrNull(value: unknown) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

function safeParseArray(raw: string): unknown {
    try {
        return JSON.parse(raw) as unknown
    } catch {
        return null
    }
}

function formatDate(value: Date | string | null | undefined) {
    if (value == null) return null
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
