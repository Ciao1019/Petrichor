import { describe, expect, it } from "vitest"

import {
  resolveDropIntentKind,
  resolvePointerY,
  resolveSiblingTargetIndex,
} from "@/features/pages/knowledge/knowledge-tree-drop"

/** 一行高 40px，顶端在 100：前 8px 是 before，后 8px 是 after，中间 24px 是 into。 */
const row = { height: 40, top: 100 }

describe("resolveDropIntentKind", () => {
  it("文件夹行中间大部分区域都判定为放入", () => {
    expect(resolveDropIntentKind(110, row, true)).toBe("into")
    expect(resolveDropIntentKind(120, row, true)).toBe("into")
    expect(resolveDropIntentKind(131, row, true)).toBe("into")
  })

  it("文件夹行上下边缘判定为排序", () => {
    expect(resolveDropIntentKind(102, row, true)).toBe("before")
    expect(resolveDropIntentKind(138, row, true)).toBe("after")
  })

  it("不能放入时整行对半分成前后", () => {
    expect(resolveDropIntentKind(110, row, false)).toBe("before")
    expect(resolveDropIntentKind(130, row, false)).toBe("after")
  })

  it("行高拿不到时退回一个确定结果，不至于误判成排序", () => {
    expect(resolveDropIntentKind(110, { height: 0, top: 100 }, true)).toBe("into")
    expect(resolveDropIntentKind(110, { height: 0, top: 100 }, false)).toBe("before")
  })
})

describe("resolvePointerY", () => {
  it("按下坐标加累计位移得到当前指针位置", () => {
    expect(resolvePointerY({ clientY: 120 } as PointerEvent, { y: -30 })).toBe(90)
  })

  it("拿不到坐标时返回 null 交给调用方兜底", () => {
    expect(resolvePointerY(null, { y: 10 })).toBeNull()
    expect(resolvePointerY(new Event("pointerdown"), { y: 10 })).toBeNull()
  })
})

describe("resolveSiblingTargetIndex", () => {
  const siblingIds = ["a", "b", "c", "d"]

  it("跨父级插入时按目标节点前/后取下标", () => {
    expect(
      resolveSiblingTargetIndex({
        activeId: "x",
        kind: "before",
        overId: "c",
        pageOffset: 0,
        sameParent: false,
        siblingIds,
      }),
    ).toBe(2)
    expect(
      resolveSiblingTargetIndex({
        activeId: "x",
        kind: "after",
        overId: "c",
        pageOffset: 0,
        sameParent: false,
        siblingIds,
      }),
    ).toBe(3)
  })

  it("同级下移时下标按摘掉自身后的列表算", () => {
    // [a,b,c,d] 把 a 排到 c 之后 → 摘掉 a 得 [b,c,d]，插到 2 位 → [b,c,a,d]
    expect(
      resolveSiblingTargetIndex({
        activeId: "a",
        kind: "after",
        overId: "c",
        pageOffset: 0,
        sameParent: true,
        siblingIds,
      }),
    ).toBe(2)
  })

  it("同级上移时下标不受自身位置影响", () => {
    // [a,b,c,d] 把 d 排到 b 之前 → 摘掉 d 得 [a,b,c]，插到 1 位 → [a,d,b,c]
    expect(
      resolveSiblingTargetIndex({
        activeId: "d",
        kind: "before",
        overId: "b",
        pageOffset: 0,
        sameParent: true,
        siblingIds,
      }),
    ).toBe(1)
  })

  it("落点等于原位置时返回 null，不发多余请求", () => {
    // b 本来就紧跟在 a 后面
    expect(
      resolveSiblingTargetIndex({
        activeId: "b",
        kind: "after",
        overId: "a",
        pageOffset: 0,
        sameParent: true,
        siblingIds,
      }),
    ).toBeNull()
    // b 本来就紧邻在 c 前面
    expect(
      resolveSiblingTargetIndex({
        activeId: "b",
        kind: "before",
        overId: "c",
        pageOffset: 0,
        sameParent: true,
        siblingIds,
      }),
    ).toBeNull()
  })

  it("根级分页时补上前几页的偏移", () => {
    expect(
      resolveSiblingTargetIndex({
        activeId: "x",
        kind: "before",
        overId: "b",
        pageOffset: 20,
        sameParent: false,
        siblingIds,
      }),
    ).toBe(21)
  })

  it("目标不在当前同级列表里时返回 null", () => {
    expect(
      resolveSiblingTargetIndex({
        activeId: "a",
        kind: "before",
        overId: "zzz",
        pageOffset: 0,
        sameParent: true,
        siblingIds,
      }),
    ).toBeNull()
  })
})
