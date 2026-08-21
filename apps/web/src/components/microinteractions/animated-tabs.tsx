"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

export type AnimatedTabsOption = {
  label: React.ReactNode;
  value: string;
  disabled?: boolean;
  /** 纯图标选项必须给出无障碍名称，否则读屏只会念出一个图形。 */
  ariaLabel?: string;
};

export type AnimatedTabsSize = "sm" | "md" | "lg";

export type AnimatedTabsProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "defaultValue" | "onChange"
> & {
  options: AnimatedTabsOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  ariaLabel?: string;
  size?: AnimatedTabsSize;
};

const SIZE_STYLES: Record<AnimatedTabsSize, { root: string; button: string }> = {
  sm: { root: "h-7", button: "px-2 text-[13px]" },
  md: { root: "h-8", button: "px-2.5 text-sm" },
  lg: { root: "h-10", button: "px-3 text-[15px]" },
};

/** 弹簧参数取自 microinteractionsui 的 tabs4：滑到位时有一点点回弹但不过冲。 */
const INDICATOR_SPRING = { type: "spring", stiffness: 100, damping: 30 } as const;

/** SSR 阶段退回 useEffect，避免 Next 对 useLayoutEffect 的告警。 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

type IndicatorRect = { left: number; width: number };

/**
 * 下划线跟随式标签栏：选中项下方的指示条用弹簧滑过去，铺满整个触发区，
 * 文字/图标的颜色延迟一拍再变，让「条先到、色后亮」的先后关系读得出来。
 *
 * 只保留这一条滑动的指示条，不铺底部轨道线：轨道被指示条盖掉一段之后，
 * 剩下的那截会被看成另一条长度不一样的下划线。
 *
 * 语义仍用 radiogroup 而不是 tablist：这里只负责切视图，
 * 页面并没有和每个选项一一对应、可被 aria-controls 指向的 tabpanel。
 */
export function AnimatedTabs({
  options,
  value,
  defaultValue,
  onValueChange,
  ariaLabel = "视图切换",
  size = "md",
  className,
  ...props
}: AnimatedTabsProps) {
  const firstEnabledValue = options.find((option) => !option.disabled)?.value ?? "";
  const [internalValue, setInternalValue] = React.useState(
    defaultValue ?? firstEnabledValue,
  );
  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const [indicator, setIndicator] = React.useState<IndicatorRect | null>(null);
  const prefersReducedMotion = useReducedMotion();
  const currentValue = value ?? (
    options.some((option) => option.value === internalValue)
      ? internalValue
      : firstEnabledValue
  );
  const selectedIndex = options.findIndex((option) => option.value === currentValue);
  const sizeStyles = SIZE_STYLES[size];

  // 指示条铺满整个触发区（含左右内边距），宽度只能量出来：
  // 文案、字体加载、容器宽度变化都会改触发区宽度。
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    const button = buttonRefs.current[selectedIndex];
    if (!root || !button) {
      setIndicator(null);
      return;
    }

    const measure = () => {
      const next = { left: button.offsetLeft, width: button.offsetWidth };
      // 必须做等值判断：options 常常是内联数组，否则会 measure -> setState -> 再 measure。
      setIndicator((prev) =>
        prev
        && Math.abs(prev.left - next.left) < 0.5
        && Math.abs(prev.width - next.width) < 0.5
          ? prev
          : next,
      );
    };

    // 容器被外层夹窄（max-w-full）时会横向滚动，选中项要先滚进来，
    // 否则指示条只露出半截，看着像被右边裁掉了。
    const ensureVisible = () => {
      const overflowRight =
        button.offsetLeft + button.offsetWidth - (root.scrollLeft + root.clientWidth);
      if (overflowRight > 0) root.scrollLeft += overflowRight;
      else if (button.offsetLeft < root.scrollLeft) root.scrollLeft = button.offsetLeft;
    };

    measure();
    ensureVisible();

    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const node of buttonRefs.current) {
      if (node) observer.observe(node);
    }
    // 中文字体晚于首帧就位，落地后文字宽度会变。
    void document.fonts?.ready.then(measure).catch(() => {});

    return () => observer.disconnect();
  }, [selectedIndex, options.length]);

  const selectValue = React.useCallback(
    (nextValue: string) => {
      if (value === undefined) setInternalValue(nextValue);
      if (nextValue !== currentValue) onValueChange?.(nextValue);
    },
    [currentValue, onValueChange, value],
  );

  const moveSelection = React.useCallback(
    (currentIndex: number, direction: 1 | -1) => {
      if (options.length === 0) return;
      let nextIndex = currentIndex;
      for (let offset = 0; offset < options.length; offset += 1) {
        nextIndex = (nextIndex + direction + options.length) % options.length;
        if (options[nextIndex]?.disabled) continue;
        buttonRefs.current[nextIndex]?.focus();
        selectValue(options[nextIndex].value);
        return;
      }
    },
    [options, selectValue],
  );

  if (options.length === 0) return null;

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "relative inline-flex max-w-full items-center overflow-x-auto scrollbar-hide",
        sizeStyles.root,
        className,
      )}
      {...props}
    >
      {options.map((option, index) => {
        const selected = option.value === currentValue;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            disabled={option.disabled}
            tabIndex={selected || (selectedIndex < 0 && index === 0) ? 0 : -1}
            className={cn(
              "relative flex h-full shrink-0 items-center justify-center gap-1.5 rounded-md outline-none",
              // 字重保持一致：切换时文字宽度不变，指示条才不会跟着抖。
              "font-medium tracking-[-0.01em] whitespace-nowrap",
              // 延迟一拍再换色：指示条先滑到位，颜色随后跟上。
              "transition-colors duration-500 delay-200",
              "focus-visible:ring-2 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-40",
              "motion-reduce:transition-none motion-reduce:delay-0",
              sizeStyles.button,
              selected
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/80",
            )}
            onClick={() => selectValue(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(index, -1);
              } else if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                const enabledIndexes = options
                  .map((item, itemIndex) => (item.disabled ? -1 : itemIndex))
                  .filter((itemIndex) => itemIndex >= 0);
                const nextIndex = event.key === "Home"
                  ? enabledIndexes[0]
                  : enabledIndexes.at(-1);
                if (nextIndex === undefined) return;
                buttonRefs.current[nextIndex]?.focus();
                selectValue(options[nextIndex].value);
              }
            }}
          >
            <span className="flex items-center gap-1.5">{option.label}</span>
          </button>
        );
      })}

      {/* 量到位置再挂载，配合 initial={false}：首屏直接落在正确位置，不做一次入场生长。 */}
      {indicator ? (
        <motion.span
          aria-hidden="true"
          // 贴着容器底边，不要越出：root 有 overflow-x-auto，往下溢出 1px 就会多出可滚动区域。
          className="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-foreground/85"
          initial={false}
          animate={{ x: indicator.left, width: indicator.width }}
          transition={prefersReducedMotion ? { duration: 0 } : INDICATOR_SPRING}
        />
      ) : null}
    </div>
  );
}
