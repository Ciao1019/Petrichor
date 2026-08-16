import { describe, expect, it } from "vitest"
import {
    AI_PURPOSES,
    decodeApiKey,
    decodeExtra,
    encodeApiKey,
    encodeExtra,
    maskApiKey,
    parseCapabilities,
    parseGenerationOptions,
    parseStringMap,
    parseModelKind,
    parsePurpose,
    PURPOSE_MODEL_KIND,
    requireId,
    requirePurpose,
    validateCredentialInput,
    validateModelInput,
    validateProviderInput,
    providerApiProtocol,
} from "./config-logic"

describe("凭证加解密", () => {
    it("API Key 可加密回读，掩码只露头尾", () => {
        const encoded = encodeApiKey("sk-1234567890abcdef")
        expect(encoded).not.toContain("sk-1234")
        expect(decodeApiKey(encoded)).toBe("sk-1234567890abcdef")
        expect(maskApiKey("sk-1234567890abcdef")).toBe("sk-1********cdef")
        expect(maskApiKey("short")).toBe("********")
        expect(maskApiKey("  ")).toBeNull()
    })

    it("额外凭证字段整体加密，空值被丢弃", () => {
        const encoded = encodeExtra({ region: "us-east-1", accessKeyId: "AKIA", empty: "  " })
        expect(encoded).not.toBeNull()
        expect(decodeExtra(encoded)).toEqual({ region: "us-east-1", accessKeyId: "AKIA" })
        expect(encodeExtra({})).toBeNull()
        expect(decodeExtra(null)).toEqual({})
    })
})

describe("通用解析", () => {
    it("用途枚举齐全且各自有对应的模型类型", () => {
        expect(AI_PURPOSES).toEqual(["CHAT", "VISION", "DOC_QA", "EMBEDDING"])
        expect(PURPOSE_MODEL_KIND.EMBEDDING).toBe("EMBEDDING")
        expect(PURPOSE_MODEL_KIND.CHAT).toBe("LANGUAGE")
        expect(PURPOSE_MODEL_KIND.VISION).toBe("LANGUAGE")
    })

    it("parsePurpose / parseModelKind 拒绝未知值", () => {
        expect(parsePurpose("CHAT")).toBe("CHAT")
        expect(parsePurpose("chat")).toBeNull()
        expect(parsePurpose(null)).toBeNull()
        expect(() => requirePurpose("nope")).toThrow(/用途不能为空/)
        expect(parseModelKind("EMBEDDING")).toBe("EMBEDDING")
        expect(parseModelKind("OTHER")).toBeNull()
    })

    it("requireId 只接受正整数字符串", () => {
        expect(requireId("12")).toBe(12)
        expect(requireId(7)).toBe(7)
        expect(() => requireId("a1")).toThrow(/非法/)
        expect(() => requireId("")).toThrow(/非法/)
    })

    it("parseStringMap 同时吃 JSON 字符串和对象，过滤空键空值", () => {
        expect(parseStringMap('{"A":"1"," ":"x","B":"  "}')).toEqual({ A: "1" })
        expect(parseStringMap({ A: " 1 ", B: 2 })).toEqual({ A: "1" })
        expect(parseStringMap("not json")).toEqual({})
        expect(parseStringMap(null)).toEqual({})
    })

    it("parseCapabilities 只保留合法能力标记", () => {
        expect(parseCapabilities(["tools", "vision", "bogus"])).toEqual(["tools", "vision"])
        expect(parseCapabilities('["json"]')).toEqual(["json"])
        expect(parseCapabilities("nope")).toEqual([])
    })
})

describe("validateCredentialInput", () => {
    it("新建时必须有名称和 API Key", () => {
        expect(() => validateCredentialInput({ apiKey: "sk" }, { requireApiKey: true }))
            .toThrow(/名称不能为空/)
        expect(() => validateCredentialInput({ name: "a" }, { requireApiKey: true }))
            .toThrow(/API Key 不能为空/)
    })

    it("更新时允许省略 API Key", () => {
        const input = validateCredentialInput({ name: "主账号" }, { requireApiKey: false })
        expect(input.apiKey).toBe("")
        expect(input.providerKey).toBeNull()
    })

    it("限定供应商必须存在于目录", () => {
        expect(validateCredentialInput(
            { name: "a", apiKey: "sk", providerKey: "openai" },
            { requireApiKey: true },
        ).providerKey).toBe("openai")
        expect(() => validateCredentialInput(
            { name: "a", apiKey: "sk", providerKey: "nope" },
            { requireApiKey: true },
        )).toThrow(/未知的供应商/)
    })
})

describe("validateProviderInput", () => {
    it("名称留空时用目录里的供应商名兜底", () => {
        const input = validateProviderInput({ providerKey: "openai", credentialId: "3" })
        expect(input.name).toBe("OpenAI")
        expect(input.baseUrl).toBeNull()
        expect(input.enabled).toBe(true)
    })

    it("BaseUrl 去掉尾部斜杠，留空存 null 以跟随默认值", () => {
        const input = validateProviderInput({
            providerKey: "openai",
            credentialId: "3",
            baseUrl: "https://proxy.test/v1//",
        })
        expect(input.baseUrl).toBe("https://proxy.test/v1")
    })

    it("自定义兼容端点必须填 BaseUrl", () => {
        expect(() => validateProviderInput({ providerKey: "openai-compatible", credentialId: "3" }))
            .toThrow(/必须填写 BaseUrl/)
    })

    it("缺少供应商或凭证时报错", () => {
        expect(() => validateProviderInput({ credentialId: "3" })).toThrow(/请选择供应商/)
        expect(() => validateProviderInput({ providerKey: "openai" })).toThrow(/凭证 ID非法/)
    })

    it("协议规范化后落盘：没传按 chat，脏值不流进 optionsJson", () => {
        expect(validateProviderInput({ providerKey: "openai", credentialId: "3" }).options.apiProtocol)
            .toBe("chat")
        expect(validateProviderInput({
            providerKey: "openai",
            credentialId: "3",
            options: { apiProtocol: "Responses" },
        }).options.apiProtocol).toBe("responses")
        expect(validateProviderInput({
            providerKey: "openai",
            credentialId: "3",
            options: { apiProtocol: "grpc" },
        }).options.apiProtocol).toBe("chat")
        // 该供应商不支持 responses 时，即使前端硬传也要挡下来
        expect(validateProviderInput({
            providerKey: "deepseek",
            credentialId: "3",
            options: { apiProtocol: "responses" },
        }).options.apiProtocol).toBe("chat")
    })
})

describe("providerApiProtocol", () => {
    it("从 optionsJson 读协议，未知供应商或空值一律按 chat", () => {
        expect(providerApiProtocol({
            providerKey: "openai",
            optionsJson: JSON.stringify({ apiProtocol: "responses" }),
        })).toBe("responses")
        expect(providerApiProtocol({ providerKey: "openai", optionsJson: null })).toBe("chat")
        expect(providerApiProtocol({ providerKey: "openai", optionsJson: "{" })).toBe("chat")
        expect(providerApiProtocol({
            providerKey: "already-removed-provider",
            optionsJson: JSON.stringify({ apiProtocol: "responses" }),
        })).toBe("chat")
    })
})

describe("validateModelInput", () => {
    it("模型 ID 与类型必填", () => {
        expect(() => validateModelInput({ kind: "LANGUAGE" })).toThrow(/模型 ID 不能为空/)
        expect(() => validateModelInput({ modelId: "gpt-5.2" })).toThrow(/LANGUAGE 或 EMBEDDING/)
    })

    it("上下文窗口只接受正整数，其余归 null", () => {
        expect(validateModelInput({ modelId: "m", kind: "LANGUAGE", contextWindow: 128000 }).contextWindow)
            .toBe(128_000)
        expect(validateModelInput({ modelId: "m", kind: "LANGUAGE", contextWindow: -1 }).contextWindow)
            .toBeNull()
        expect(validateModelInput({ modelId: "m", kind: "LANGUAGE", contextWindow: "abc" }).contextWindow)
            .toBeNull()
    })
})

describe("parseGenerationOptions", () => {
    it("兼容 JSON 字符串与对象，缺省值合理", () => {
        expect(parseGenerationOptions(null)).toEqual({
            maxTokens: null,
            temperature: null,
            thinking: null,
            disableThinkingForTools: true,
        })
        expect(parseGenerationOptions('{"maxTokens":2048,"temperature":0.3}')).toMatchObject({
            maxTokens: 2048,
            temperature: 0.3,
        })
    })

    it("thinking 接受布尔、字符串和对象三种写法", () => {
        expect(parseGenerationOptions({ thinking: true }).thinking).toBe("enabled")
        expect(parseGenerationOptions({ thinking: "disabled" }).thinking).toBe("disabled")
        expect(parseGenerationOptions({ thinking: { type: "enabled" } }).thinking).toBe("enabled")
        expect(parseGenerationOptions({ thinking: "weird" }).thinking).toBeNull()
    })

    it("temperature 为 0 时保留而不是当成缺省", () => {
        expect(parseGenerationOptions({ temperature: 0 }).temperature).toBe(0)
    })

    it("disableThinkingForTools 默认开启，可显式关闭", () => {
        expect(parseGenerationOptions({}).disableThinkingForTools).toBe(true)
        expect(parseGenerationOptions({ disableThinkingForTools: false }).disableThinkingForTools).toBe(false)
        expect(parseGenerationOptions({ disableThinkingForTools: "off" }).disableThinkingForTools).toBe(false)
    })
})
