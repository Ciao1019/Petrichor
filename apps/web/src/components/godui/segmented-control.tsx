"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export type SegmentedControlOption = {
  label: React.ReactNode;
  value: string;
  disabled?: boolean;
  /** 纯图标选项必须给出无障碍名称，否则读屏只会念出一个图形。 */
  ariaLabel?: string;
};

export type SegmentedControlSize = "sm" | "md" | "lg";

export type SegmentedControlProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "defaultValue" | "onChange"
> & {
  options: SegmentedControlOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  ariaLabel?: string;
  size?: SegmentedControlSize;
};

const SIZE_STYLES: Record<SegmentedControlSize, { root: string; button: string }> = {
  sm: { root: "h-7 gap-1", button: "px-2 text-[13px]" },
  md: { root: "h-8 gap-1.5", button: "px-2.5 text-sm" },
  lg: { root: "h-10 gap-2.5", button: "px-3 text-[15px]" },
};

/** SSR 阶段退回 useEffect，避免 Next 对 useLayoutEffect 的告警。 */
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

type IndicatorRect = { left: number; width: number };

export function SegmentedControl({
  options,
  value,
  defaultValue,
  onValueChange,
  ariaLabel = "视图切换",
  size = "md",
  className,
  ...props
}: SegmentedControlProps) {
  const firstEnabledValue = options.find((option) => !option.disabled)?.value ?? "";
  const [internalValue, setInternalValue] = React.useState(
    defaultValue ?? firstEnabledValue,
  );
  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const labelRefs = React.useRef<Array<HTMLSpanElement | null>>([]);
  const [indicator, setIndicator] = React.useState<IndicatorRect | null>(null);
  const currentValue = value ?? (
    options.some((option) => option.value === internalValue)
      ? internalValue
      : firstEnabledValue
  );
  const selectedIndex = options.findIndex((option) => option.value === currentValue);
  const sizeStyles = SIZE_STYLES[size];

  // 下划线宽度跟着文字走，只能量出来：文案、字体加载、容器宽度变化都要重新量。
  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    const label = labelRefs.current[selectedIndex];
    if (!root || !label) {
      setIndicator(null);
      return;
    }

    const measure = () => {
      const rootRect = root.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      const next = {
        left: labelRect.left - rootRect.left + root.scrollLeft,
        width: labelRect.width,
      };
      // 必须做等值判断：options 常常是内联数组，否则会 measure -> setState -> 再 measure。
      setIndicator((prev) =>
        prev
        && Math.abs(prev.left - next.left) < 0.5
        && Math.abs(prev.width - next.width) < 0.5
          ? prev
          : next,
      );
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const node of labelRefs.current) {
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
              // 字重保持一致：切换时文字宽度不变，下划线才不会跟着抖。
              "font-medium tracking-[-0.01em] whitespace-nowrap",
              "transition-[color,transform] duration-200 ease-out active:scale-[0.98]",
              "focus-visible:ring-2 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-40",
              "motion-reduce:transition-none motion-reduce:active:scale-100",
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
            <span
              ref={(node) => {
                labelRefs.current[index] = node;
              }}
              className="flex items-center gap-1.5"
            >
              {option.label}
            </span>
          </button>
        );
      })}

      {indicator ? (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute bottom-0 left-0 h-[2px] rounded-full will-change-transform",
            "bg-foreground/85",
            "transition-[transform,width] duration-300 [transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
            "motion-reduce:transition-none",
          )}
          style={{
            width: `${indicator.width}px`,
            transform: `translateX(${indicator.left}px)`,
          }}
        />
      ) : null}
    </div>
  );
}
