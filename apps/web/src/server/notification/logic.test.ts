import { describe, expect, it } from "vitest"
import {
    buildNotificationItem,
    parseNotificationPayload,
    resolveNotificationOrder,
    validateNotificationListInput,
    validateNotificationReadAllInput,
    validateNotificationReadInput,
} from "./logic"

describe("notification logic", () => {
    it("校验列表筛选参数", () => {
        expect(validateNotificationListInput({
            category: " SYSTEM ",
            readStatus: "UNREAD",
        })).toMatchObject({
            category: "SYSTEM",
            readStatus: "UNREAD",
        })

        expect(() => validateNotificationListInput({
            readStatus: "ARCHIVED",
        })).toThrow("readStatus 非法")
    })

    it("校验消息 ID 和批量已读分类", () => {
        expect(validateNotificationReadInput({ notificationId: " 12 " })).toEqual({ notificationId: 12 })
        expect(() => validateNotificationReadInput({ notificationId: "x" })).toThrow("消息ID非法")

        expect(validateNotificationReadAllInput({ category: " test " })).toEqual({ category: "test" })
        expect(() => validateNotificationReadAllInput({ category: "x".repeat(51) })).toThrow("消息分类长度不能超过 50")
    })

    it("解析 payload JSON，空值返回空对象", () => {
        expect(parseNotificationPayload(null)).toEqual({})
        expect(parseNotificationPayload("")).toEqual({})
        expect(parseNotificationPayload("{\"articleId\":\"1\"}")).toEqual({ articleId: "1" })
    })

    it("构造 Go 兼容的消息响应", () => {
        const item = buildNotificationItem({
            bizId: 99,
            bizType: "SYSTEM_NOTICE",
            category: "SYSTEM",
            content: "内容",
            createdAt: new Date("2026-04-27T00:00:00.000Z"),
            id: 7,
            payloadJson: "{\"source\":\"test\"}",
            readAt: new Date("2026-04-27T01:00:00.000Z"),
            title: "标题",
            updatedAt: new Date("2026-04-27T01:00:00.000Z"),
            userId: 1,
        })

        expect(item).toEqual({
            bizId: "99",
            bizType: "SYSTEM_NOTICE",
            category: "SYSTEM",
            content: "内容",
            createdAt: "2026-04-27T00:00:00.000Z",
            id: "7",
            payload: { source: "test" },
            read: true,
            readAt: "2026-04-27T01:00:00.000Z",
            title: "标题",
        })
    })

    it("按 QueryBuilder 规则解析默认和自定义排序", () => {
        expect(resolveNotificationOrder({})).toEqual([
            { column: "createdAt", direction: "desc" },
            { column: "id", direction: "desc" },
        ])
        expect(resolveNotificationOrder({
            isAsc: "ascending,descending",
            orderByColumn: "readAt,id",
        })).toEqual([
            { column: "readAt", direction: "asc" },
            { column: "id", direction: "desc" },
        ])
    })
})
