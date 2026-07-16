import { describe, expect, it } from "vitest"
import { readPersistedTiming } from "./assistant-message-utils"

describe("readPersistedTiming", () => {
    it("从 custom 扁平字段读取", () => {
        expect(readPersistedTiming({
            custom: { totalStreamTime: 1200, tokensPerSecond: 40, firstTokenTime: 200 },
        })).toEqual({
            firstTokenTime: 200,
            totalStreamTime: 1200,
            tokensPerSecond: 40,
            totalChunks: 0,
        })
    })

    it("兼容 metadata.timing 嵌套", () => {
        expect(readPersistedTiming({
            timing: { totalStreamTime: 800, tokensPerSecond: 12.5, totalChunks: 3 },
        })).toEqual({
            firstTokenTime: undefined,
            totalStreamTime: 800,
            tokensPerSecond: 12.5,
            totalChunks: 3,
        })
    })

    it("无耗时时返回 undefined", () => {
        expect(readPersistedTiming({ custom: { usage: { totalTokens: 10 } } })).toBeUndefined()
        expect(readPersistedTiming(null)).toBeUndefined()
    })
})
