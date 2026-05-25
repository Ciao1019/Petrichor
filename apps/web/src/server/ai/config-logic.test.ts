import { describe, expect, it } from "vitest"
import {
    applyDefaultBaseUrl,
    decodeApiKey,
    encodeApiKey,
    maskApiKey,
    validateAiConfigCreateInput,
    validateAiConfigIdInput,
} from "./config-logic"

describe("ai model config logic", () => {
    it("校验创建配置并应用默认值", () => {
        expect(validateAiConfigCreateInput({
            apiKey: "sk-test",
            configType: "CHAT",
            model: "gpt-4o-mini",
            name: "默认 Chat",
            protocol: "OPENAI",
        })).toMatchObject({
            baseUrl: "https://api.openai.com/v1",
            enabled: true,
            isDefault: false,
        })

        expect(() => validateAiConfigCreateInput({ protocol: "OPENAI" })).toThrow("配置类型不能为空")
        expect(() => validateAiConfigCreateInput({ configType: "CHAT", model: "m", name: "n", protocol: "OPENAI_COMPAT" })).toThrow("OPENAI_COMPAT 协议必须填写 BaseUrl")
    })

    it("校验配置 ID", () => {
        expect(validateAiConfigIdInput({ id: " 8 " })).toEqual({ id: 8 })
        expect(() => validateAiConfigIdInput({ id: "x" })).toThrow("配置ID非法")
    })

    it("处理 API Key 编码和掩码", () => {
        const encoded = encodeApiKey("sk-1234567890")

        expect(encoded).not.toBe("sk-1234567890")
        expect(encoded).not.toMatch(/^b64:/)
        expect(decodeApiKey(encoded)).toBe("sk-1234567890")
        expect(maskApiKey("sk-1234567890")).toBe("sk-1********7890")
        expect(maskApiKey("short")).toBe("********")
    })

    it("按协议返回默认 BaseUrl", () => {
        expect(applyDefaultBaseUrl("OPENAI", null)).toBe("https://api.openai.com/v1")
        expect(applyDefaultBaseUrl("DEEPSEEK", null)).toBe("https://api.deepseek.com/v1")
        expect(applyDefaultBaseUrl("SILICONFLOW", null)).toBe("https://api.siliconflow.cn/v1")
        expect(applyDefaultBaseUrl("OPENAI_COMPAT", " https://api.example.com/v1 ")).toBe("https://api.example.com/v1")
    })
})
