import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto"

const pbkdf2Iterations = 1024
const aesKeyLengthBytes = 32
const aesBlockSizeBytes = 16

export function encryptText(key: string, saltHex: string, plainText: string) {
    const secretKey = deriveAesKey(key, saltHex)
    const iv = randomBytes(aesBlockSizeBytes)
    const cipher = createCipheriv("aes-256-cbc", secretKey, iv)
    const encrypted = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
    ])
    return Buffer.concat([iv, encrypted]).toString("hex")
}

export function decryptText(key: string, saltHex: string, cipherHex: string) {
    const secretKey = deriveAesKey(key, saltHex)
    if (!/^[0-9a-fA-F]+$/.test(cipherHex)) {
        throw new Error("密文 hex 解码失败")
    }
    const raw = Buffer.from(cipherHex, "hex")
    if (raw.length < aesBlockSizeBytes * 2 || raw.length % aesBlockSizeBytes !== 0) {
        throw new Error("密文长度非法")
    }
    const iv = raw.subarray(0, aesBlockSizeBytes)
    const payload = raw.subarray(aesBlockSizeBytes)
    const decipher = createDecipheriv("aes-256-cbc", secretKey, iv)
    return Buffer.concat([
        decipher.update(payload),
        decipher.final(),
    ]).toString("utf8")
}

function deriveAesKey(key: string, saltHex: string) {
    if (!key.trim()) {
        throw new Error("encrypt-key 不能为空")
    }
    if (!saltHex.trim()) {
        throw new Error("encrypt-salt 不能为空")
    }
    if (saltHex.length % 2 !== 0) {
        throw new Error("encrypt-salt 必须为偶数长度的 hex 字符串")
    }
    if (!/^[0-9a-fA-F]+$/.test(saltHex)) {
        throw new Error("encrypt-salt 必须为合法的 hex 字符串")
    }
    return pbkdf2Sync(key, Buffer.from(saltHex, "hex"), pbkdf2Iterations, aesKeyLengthBytes, "sha1")
}
