// @vitest-environment jsdom

import * as React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("motion/react", () => ({ useInView: () => true }));

import { Highlighter } from "./highlighter";

const observers: TestResizeObserver[] = [];

class TestResizeObserver {
  targets = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }

  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
}

function notifyResize(target: Element) {
  act(() => {
    for (const observer of observers) {
      if (observer.targets.has(target)) {
        observer.callback(
          [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
          observer,
        );
      }
    }
    vi.advanceTimersByTime(450);
  });
}

let containerTop: number;
let lineRects: DOMRect[];

beforeEach(() => {
  vi.useFakeTimers();
  observers.length = 0;
  containerTop = 100;
  lineRects = [new DOMRect(20, 10, 180, 24)];
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
    return this.closest("[data-annotation-container]");
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    return new DOMRect(0, containerTop, 400, 100);
  });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function () {
    return lineRects.map((rect) => new DOMRect(rect.x, rect.y + containerTop, rect.width, rect.height)) as unknown as DOMRectList;
  });
  // 使用真实 rough-notation 渲染，仅补齐 jsdom 不提供的 SVG 路径测量。
  const createElementNS = document.createElementNS.bind(document);
  vi.spyOn(document, "createElementNS").mockImplementation((namespace, name, options) => {
    const element = createElementNS(namespace, name, options);
    if (name === "path") Object.assign(element, { getTotalLength: () => 180 });
    return element;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function renderHighlight(props: Partial<React.ComponentProps<typeof Highlighter>> = {}) {
  return render(
    <main>
      <section aria-label="AI 总结">逐字展示的 AI 总结</section>
      <div data-annotation-container style={{ position: "relative" }}>
        <Highlighter action="underline" {...props}>因果编码器-解码器</Highlighter>
      </div>
    </main>,
  );
}

function paths(container: HTMLElement) {
  return Array.from(container.querySelectorAll<SVGElement>(".rough-annotation path"));
}

describe("Highlighter 布局更新", () => {
  it("首次绘制保留动画，初始尺寸通知和总结增高不会重播或替换笔迹", () => {
    const { container } = renderHighlight();
    const originalPaths = paths(container);
    const block = container.querySelector("[data-annotation-container]")!;
    const text = container.querySelector("span")!;
    expect(originalPaths).toHaveLength(2);
    expect(originalPaths.every((path) => path.style.animation !== "")).toBe(true);

    notifyResize(text);
    notifyResize(block);
    for (let i = 0; i < 10; i++) {
      containerTop += 24;
      container.querySelector("section")!.textContent += "新增一行总结";
      notifyResize(document.body);
      notifyResize(block);
    }

    expect(paths(container)).toEqual(originalPaths);
    expect(originalPaths.every((path) => path.isConnected)).toBe(true);
  });

  it("窄屏换行会重新对齐多行笔迹，但不再播放绘制动画", () => {
    const { container } = renderHighlight();
    const originalPaths = paths(container);
    lineRects = [new DOMRect(20, 10, 100, 24), new DOMRect(0, 34, 80, 24)];

    notifyResize(container.querySelector("[data-annotation-container]")!);

    expect(paths(container)).toHaveLength(4);
    expect(paths(container).every((path) => path.style.animation === "")).toBe(true);
    expect(originalPaths.every((path) => !path.isConnected)).toBe(true);
  });

  it("容器内文字位置变化时静态校正笔迹", () => {
    const { container } = renderHighlight();
    const originalD = paths(container)[0]!.getAttribute("d");
    lineRects = [new DOMRect(20, 50, 180, 24)];

    notifyResize(container.querySelector("[data-annotation-container]")!);

    expect(paths(container)[0]!.getAttribute("d")).not.toBe(originalD);
    expect(paths(container).every((path) => path.style.animation === "")).toBe(true);
  });

  it.each(["减少动态效果", "零时长"])("%s时首次绘制也没有动画", (mode) => {
    if (mode === "减少动态效果") {
      vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    }
    const { container } = renderHighlight(mode === "零时长" ? { animationDuration: 0 } : {});

    expect(paths(container)).toHaveLength(2);
    expect(paths(container).every((path) => path.style.animation === "")).toBe(true);
  });

  it("卸载后移除笔迹和尺寸监听", () => {
    const { container, unmount } = renderHighlight();
    const originalPaths = paths(container);
    unmount();

    expect(originalPaths.every((path) => !path.isConnected)).toBe(true);
    expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
  });
});
