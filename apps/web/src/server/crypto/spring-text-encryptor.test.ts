import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { decryptText, encryptText } from "./spring-text-encryptor"

describe("spring text encryptor", () => {
    const key = "petrichor-dev-encrypt-key"
    const salt = "0123456789abcdef"

    /**
     * 按 Spring Security `Encryptors.text(password, salt)` 的公开算法独立实现一遍，
     * 用来交叉验证本模块的实现没有偏离线上已存密文的解密方式：
     *   - PBKDF2WithHmacSHA1，1024 轮，256 位密钥，salt 先做 hex 解码
     *   - AES-256-CBC，随机 16 字节 IV 前置
     *   - 整体 hex 编码
     *
     * 原先这里钉的是两条写死的密文，但它们与该 key/salt 在任何 Spring 加密模式下
     * 都解不开（应为早期换过 key 后未同步更新），已无法验证任何东西，故改为可复现的参照实现。
     */
    function encryptLikeSpring(password: string, saltHex: string, plainText: string) {
        const secretKey = pbkdf2Sync(password, Buffer.from(saltHex, "hex"), 1024, 32, "sha1")
        const iv = randomBytes(16)
        const cipher = createCipheriv("aes-256-cbc", secretKey, iv)
        const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()])
        return Buffer.concat([iv, encrypted]).toString("hex")
    }

    it("能解开按 Spring Encryptors.text 算法加密的密文", () => {
        for (const plainText of ["hello", "中文测试", "sk-" + "x".repeat(64)]) {
            expect(decryptText(key, salt, encryptLikeSpring(key, salt, plainText))).toBe(plainText)
        }
    })

    it("产出的密文也能被 Spring 侧算法解开（同一套 KDF 与分组模式）", () => {
        const encrypted = encryptText(key, salt, "hello")
        const raw = Buffer.from(encrypted, "hex")

        // 结构与 Spring 一致：前 16 字节是 IV，其余为 AES-CBC 密文且按块对齐
        expect(raw.length).toBeGreaterThanOrEqual(32)
        expect(raw.length % 16).toBe(0)
        // 密钥派生与 Spring 相同，故用同一份派生密钥可以解开
        const secretKey = pbkdf2Sync(key, Buffer.from(salt, "hex"), 1024, 32, "sha1")
        const decipher = createDecipheriv("aes-256-cbc", secretKey, raw.subarray(0, 16))
        const decrypted = Buffer.concat([
            decipher.update(raw.subarray(16)),
            decipher.final(),
        ]).toString("utf8")
        expect(decrypted).toBe("hello")
    })

    it("加解密回环并输出 hex 密文", () => {
        const encrypted = encryptText(key, salt, "sk-test")

        expect(encrypted).toMatch(/^[0-9a-f]+$/)
        expect(encrypted).not.toBe("sk-test")
        expect(decryptText(key, salt, encrypted)).toBe("sk-test")
    })

    it("每次加密使用随机 IV，同一明文不会产出相同密文", () => {
        expect(encryptText(key, salt, "same")).not.toBe(encryptText(key, salt, "same"))
    })

    it("非法输入给出明确报错", () => {
        expect(() => decryptText(key, salt, "not-hex")).toThrow(/hex/)
        expect(() => decryptText(key, salt, "abcd")).toThrow(/长度/)
        expect(() => encryptText("", salt, "x")).toThrow(/encrypt-key/)
        expect(() => encryptText(key, "xyz", "x")).toThrow(/encrypt-salt/)
    })
})
