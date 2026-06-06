import { deflateRawSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { unzip } from "./mineru"

interface ZipInput {
    name: string
    data: Buffer
    /** 0 = 存储，8 = Deflate */
    method: 0 | 8
}

/** 构造一个最小可用的标准 ZIP，用于测试解压逻辑。 */
function buildZip(files: ZipInput[]): Buffer {
    const localChunks: Buffer[] = []
    const centralChunks: Buffer[] = []
    let offset = 0

    for (const file of files) {
        const name = Buffer.from(file.name, "utf8")
        const stored = file.method === 8 ? deflateRawSync(file.data) : file.data

        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0, 6)
        local.writeUInt16LE(file.method, 8)
        local.writeUInt32LE(0, 14) // crc（解压逻辑不校验）
        local.writeUInt32LE(stored.length, 18)
        local.writeUInt32LE(file.data.length, 22)
        local.writeUInt16LE(name.length, 26)
        local.writeUInt16LE(0, 28)

        const localOffset = offset
        localChunks.push(local, name, stored)
        offset += local.length + name.length + stored.length

        const central = Buffer.alloc(46)
        central.writeUInt32LE(0x02014b50, 0)
        central.writeUInt16LE(20, 4)
        central.writeUInt16LE(20, 6)
        central.writeUInt16LE(file.method, 10)
        central.writeUInt32LE(0, 16) // crc
        central.writeUInt32LE(stored.length, 20)
        central.writeUInt32LE(file.data.length, 24)
        central.writeUInt16LE(name.length, 28)
        central.writeUInt32LE(localOffset, 42)
        centralChunks.push(central, name)
    }

    const centralBuf = Buffer.concat(centralChunks)
    const centralOffset = offset
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(files.length, 8)
    eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(centralOffset, 16)

    return Buffer.concat([...localChunks, centralBuf, eocd])
}

describe("mineru unzip", () => {
    it("解压存储（未压缩）条目", () => {
        const zip = buildZip([{ name: "full.md", data: Buffer.from("# 标题", "utf8"), method: 0 }])
        const entries = unzip(zip)
        expect(entries).toHaveLength(1)
        expect(entries[0].name).toBe("full.md")
        expect(entries[0].data.toString("utf8")).toBe("# 标题")
    })

    it("解压 Deflate 压缩条目并跳过目录项", () => {
        const content = "正文".repeat(100)
        const zip = buildZip([
            { name: "doc/", data: Buffer.alloc(0), method: 0 },
            { name: "doc/full.md", data: Buffer.from(content, "utf8"), method: 8 },
            { name: "doc/images/a.jpg", data: Buffer.from([1, 2, 3, 4]), method: 0 },
        ])
        const entries = unzip(zip)
        const names = entries.map((e) => e.name)
        expect(names).toContain("doc/full.md")
        expect(names).toContain("doc/images/a.jpg")
        expect(names).not.toContain("doc/")
        expect(entries.find((e) => e.name === "doc/full.md")?.data.toString("utf8")).toBe(content)
    })
})
