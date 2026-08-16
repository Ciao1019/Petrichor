"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { motion, useReducedMotion, useScroll, useTransform, type MotionValue } from "motion/react";

// Inertial wheel list - the iOS picker drum, rebuilt on one principle: the
// SCROLL POSITION IS THE STATE. Nothing is scroll-jacked and no library fakes
// the physics: the scroller is a plain overflow-y list, so the browser (and a
// thumb on a phone) owns momentum, and `scroll-snap-type: y mandatory` +
// `scroll-snap-align: center` land every fling on an item. The selection is
// DERIVED from scrollTop - round(scrollTop / itemHeight) - never stored beside
// it, so the two can't disagree.
//
// The drum look is paint, not layout: motion's `useScroll` tracks the scroller
// and every item derives `rotateX(±38° · t) scale(1.14 → 0.80)` and opacity from
// its distance to the viewport's centre via `useTransform` - motion values
// update outside the React render loop, GPU-composited, no per-frame setState.
// The edge fade is a `mask-image` gradient on the scroller, so items dissolve at
// the rim instead of clipping.
//
// Settling: `scrollend` fires when the snap lands, but not in every engine, so
// a 140ms quiet-timer fallback commits the same selection. Keyboard follows the
// listbox pattern - the scroller is the single tab stop, arrows/Home/End scroll
// to the neighbour (which updates selection because selection IS scroll) and
// aria-activedescendant tracks the centre item. Honours prefers-reduced-motion:
// transforms stay flat, programmatic scrolls jump.
//
// Geometry lives in three CSS custom properties on the root (--wheel-w/-h/-item)
// so the same wheel is fluid on a phone. Fully Tailwind; animation via motion/react.
//
// 本仓库改动（仅两处，API 与行为不变）：
// 1. 原源码用 `shadow-border`（lab-theme registry 的 token），本项目没有该 utility，
//    换成项目通用的 `border`；
// 2. 列表 key 原本是 items 字符串本身，模型/凭证列表允许重名，重复 key 会让 React
//    复用错行，改为 `${i}-${item}`。

const WHEEL_VARS = {
  "--wheel-w": "14rem",
  "--wheel-h": "12.5rem",
  "--wheel-item": "2.5rem",
} as CSSProperties;

export interface WheelState {
  value: string;
  index: number;
  count: number;
  settled: boolean;
}

interface Metrics {
  itemH: number;
  centers: number[];
  half: number;
}

// Fallback geometry (16px root): item 40px, viewport 200px - used until the
// first real measure lands.
const fallbackMetrics = (count: number): Metrics => ({
  itemH: 40,
  centers: Array.from({ length: count }, (_, i) => 80 + 40 * i + 20),
  half: 100,
});

export default function WheelList({
  items,
  label = "Pick a value",
  initialIndex = 0,
  drum = true,
  inspect = false,
  onStateChange,
}: {
  items: string[];
  label?: string;
  initialIndex?: number;
  drum?: boolean;
  inspect?: boolean;
  onStateChange?: (state: WheelState) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const settleTimer = useRef(0);
  const idBase = useId();
  const reduced = useReducedMotion();

  const [metrics, setMetrics] = useState<Metrics>(() => fallbackMetrics(items.length));
  const [index, setIndex] = useState(initialIndex);
  const [settled, setSettled] = useState(true);
  const indexRef = useRef(initialIndex);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;

  const { scrollY } = useScroll({ container: scrollerRef });

  const clampIndex = useCallback(
    (i: number) => Math.min(Math.max(i, 0), items.length - 1),
    [items.length],
  );

  function handleScroll() {
    // Selection derives from the scroll on every frame; it commits when the
    // snap lands (scrollend where the engine has it, the quiet-timer elsewhere).
    const scroller = scrollerRef.current;
    if (scroller) {
      const next = clampIndex(Math.round(scroller.scrollTop / metricsRef.current.itemH));
      if (next !== indexRef.current) {
        indexRef.current = next;
        setIndex(next);
      }
    }
    setSettled(false);
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setSettled(true), 140);
  }

  function handleScrollEnd() {
    window.clearTimeout(settleTimer.current);
    setSettled(true);
  }

  function scrollToIndex(i: number, smooth = true) {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTo({
      top: clampIndex(i) * metricsRef.current.itemH,
      behavior: smooth && !reduced ? "smooth" : "auto",
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const steps: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5 };
    let target: number;
    if (event.key in steps) target = indexRef.current + steps[event.key];
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = items.length - 1;
    else return;
    event.preventDefault();
    scrollToIndex(target);
  }

  // Measure once (and on resize / new items): item height, each centre, and the
  // half-viewport - cached so the motion transforms never read layout.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return undefined;
    const measure = () => {
      const options = scroller.querySelectorAll<HTMLElement>('[role="option"]');
      if (!options.length) return;
      setMetrics({
        itemH: options[0].offsetHeight,
        centers: Array.from(options, (el) => el.offsetTop + el.offsetHeight / 2),
        half: scroller.clientHeight / 2,
      });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(scroller);
    return () => observer?.disconnect();
  }, [items]);

  // Land on the initial value before first paint - no snap animation on load.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollTop = clampIndex(initialIndex) * metricsRef.current.itemH;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  useEffect(() => {
    onStateChange?.({ value: items[index], index, count: items.length, settled });
  }, [items, index, settled, onStateChange]);

  const optionId = (i: number) => `${idBase}-opt-${i}`;
  const value = items[index];

  return (
    <div className="relative w-full max-w-[var(--wheel-w)]" style={WHEEL_VARS}>
      <div className="relative p-2 rounded-[1.25rem] bg-card border">
        {/* The selection lens: a static bar the centred item scrolls through. */}
        <span
          className="absolute left-2 right-2 top-1/2 h-[var(--wheel-item)] -translate-y-1/2 rounded-xl bg-muted pointer-events-none"
          aria-hidden="true"
        />
        <div
          className="relative h-[var(--wheel-h)] overflow-y-auto overscroll-contain rounded-xl [scroll-snap-type:y_mandatory] [perspective:44rem] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [mask-image:linear-gradient(to_bottom,transparent_0,#000_30%,#000_70%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,#000_30%,#000_70%,transparent_100%)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          ref={scrollerRef}
          role="listbox"
          aria-label={label}
          aria-activedescendant={optionId(index)}
          tabIndex={0}
          data-drum={drum ? "true" : "false"}
          onScroll={handleScroll}
          onScrollEnd={handleScrollEnd}
          onKeyDown={handleKeyDown}
        >
          <ul className="[padding-block:calc((var(--wheel-h)-var(--wheel-item))/2)]">
            {items.map((item, i) => (
              <Option
                key={`${i}-${item}`}
                id={optionId(i)}
                label={item}
                selected={i === index}
                scrollY={scrollY}
                center={metrics.centers[i] ?? fallbackMetrics(items.length).centers[i]}
                half={metrics.half}
                drum={drum}
                flat={Boolean(reduced)}
                onClick={() => scrollToIndex(i)}
              />
            ))}
          </ul>
        </div>
        {inspect && (
          <>
            <span
              className="absolute left-1 right-1 top-1/2 z-[5] border-t-[1.5px] border-dashed border-[#ef4444] pointer-events-none"
              aria-hidden="true"
            />
            <span className="absolute z-[6] top-1 left-1/2 -translate-x-1/2 px-[0.3125rem] py-[0.0625rem] text-[0.625rem] leading-normal font-medium tracking-[0.01em] whitespace-nowrap bg-white rounded-[0.25rem] shadow-[0_1px_2px_rgba(0,0,0,0.08)] pointer-events-none tabular-nums text-[#dc2626] border border-[#fecaca]">
              {drum ? "rotateX(38° · t) · " : ""}scale(1.14 − 0.34|t|)
            </span>
            <span className="absolute z-[6] bottom-1 left-1/2 -translate-x-1/2 px-[0.3125rem] py-[0.0625rem] text-[0.625rem] leading-normal font-medium tracking-[0.01em] whitespace-nowrap bg-white rounded-[0.25rem] shadow-[0_1px_2px_rgba(0,0,0,0.08)] pointer-events-none tabular-nums text-[#2563eb] border border-[#bfdbfe]">
              index = round(scrollTop / {metrics.itemH}px) · snap mandatory
            </span>
          </>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {settled ? `Selected ${value}` : "Scrolling"}
      </p>
    </div>
  );
}

// One drum row. `t` is the item's signed distance from the viewport centre in
// half-viewport units - the centre item is biggest (scale 1.14) and the rim
// dissolves, by continuous function rather than a styled selected class. All
// four styles are motion values derived from the scroll: no React re-render,
// no layout read, GPU-composited.
function Option({
  id,
  label,
  selected,
  scrollY,
  center,
  half,
  drum,
  flat,
  onClick,
}: {
  id: string;
  label: string;
  selected: boolean;
  scrollY: MotionValue<number>;
  center: number;
  half: number;
  drum: boolean;
  flat: boolean;
  onClick: () => void;
}) {
  const t = useTransform(scrollY, (v) => Math.max(-1, Math.min(1, (center - (v + half)) / half)));
  const rotateX = useTransform(t, (tv) => (flat || !drum ? 0 : -38 * tv));
  const scale = useTransform(t, (tv) => (flat ? 1 : 1.14 - 0.34 * Math.abs(tv)));
  const opacity = useTransform(t, (tv) => (flat ? 1 : 1 - 0.55 * Math.abs(tv)));

  return (
    <motion.li
      id={id}
      role="option"
      aria-selected={selected}
      className="h-[var(--wheel-item)] flex items-center justify-center [scroll-snap-align:center] text-[0.9375rem] font-medium tabular-nums text-foreground cursor-pointer select-none"
      style={{ rotateX, scale, opacity }}
      onClick={onClick}
    >
      {label}
    </motion.li>
  );
}
