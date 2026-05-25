import { describe, expect, it } from "vitest"
import { decryptText, encryptText } from "./spring-text-encryptor"

describe("spring text encryptor", () => {
    const key = "petrichor-dev-encrypt-key"
    const salt = "0123456789abcdef"

    it("解密 Java Spring Encryptors.text 生成的密文", () => {
        expect(decryptText(key, salt, "1130c3efc75507d77d45edef578422fe6aa367cb7726378b9e7bf092d144249a")).toBe("hello")
        expect(decryptText(key, salt, "f81e5b72f8894ed620870da19a4dabcec4765750ff00bab4b62f33b694aa535d")).toBe("中文测试")
    })

    it("加解密回环并输出 hex 密文", () => {
        const encrypted = encryptText(key, salt, "sk-test")

        expect(encrypted).toMatch(/^[0-9a-f]+$/)
        expect(encrypted).not.toBe("sk-test")
        expect(decryptText(key, salt, encrypted)).toBe("sk-test")
    })
})
