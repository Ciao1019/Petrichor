"use client";

import { useInView } from "motion/react";
import * as React from "react";
import { annotate } from "rough-notation";
import type { RoughAnnotation } from "rough-notation/lib/model";

import { cn } from "@/lib/utils";

export type HighlighterAction =
  | "highlight"
  | "underline"
  | "box"
  | "circle"
  | "strike-through"
  | "crossed-off"
  | "bracket";

export type HighlighterProps = React.HTMLAttributes<HTMLSpanElement> & {
  children: React.ReactNode;
  /** Annotation style drawn over the text */
  action?: HighlighterAction;
  /** Annotation color (any CSS color string) */
  color?: string;
  /** Stroke width of the sketch annotation */
  strokeWidth?: number;
  /** Duration of the draw-in animation in milliseconds */
  animationDuration?: number;
  /** Number of sketch passes (higher looks more hand-drawn) */
  iterations?: number;
  /** Padding between the text and the annotation */
  padding?: number;
  /** Allow the annotation to wrap across multiple lines */
  multiline?: boolean;
  /** Only draw the annotation once the element scrolls into view */
  isView?: boolean;
};

function readAnnotationRects(element: HTMLElement, multiline: boolean) {
  const container = element.offsetParent;
  const origin = container?.getBoundingClientRect();
  const rects = multiline
    ? Array.from(element.getClientRects())
    : [element.getBoundingClientRect()];

  // 标注与文字共用定位容器，整段随总结下移时，相对坐标并没有变化。
  return rects.flatMap((rect) => [
    rect.left - (origin?.left ?? 0) + (container?.scrollLeft ?? 0),
    rect.top - (origin?.top ?? 0) + (container?.scrollTop ?? 0),
    rect.width,
    rect.height,
  ]);
}

const Highlighter = React.forwardRef<HTMLSpanElement, HighlighterProps>(
  (
    {
      children,
      className,
      action = "highlight",
      color = "#ffd1dc",
      strokeWidth = 1.5,
      animationDuration = 600,
      iterations = 2,
      padding = 2,
      multiline = true,
      isView = false,
      ...props
    },
    ref,
  ) => {
    const elementRef = React.useRef<HTMLSpanElement>(null);
    const mergedRef = React.useCallback(
      (node: HTMLSpanElement | null) => {
        elementRef.current = node;
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref],
    );

    const isInView = useInView(elementRef, {
      once: true,
      margin: "-10%",
    });

    const prefersReducedMotion = React.useMemo(() => {
      if (typeof window === "undefined") return false;
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }, []);

    const shouldShow = !isView || isInView;
    const resolvedDuration = prefersReducedMotion ? 0 : animationDuration;

    React.useLayoutEffect(() => {
      const element = elementRef.current;
      let annotation: RoughAnnotation | null = null;
      let resizeObserver: ResizeObserver | null = null;

      if (shouldShow && element) {
        const currentAnnotation = annotate(element, {
          type: action,
          color,
          strokeWidth,
          animate: !prefersReducedMotion && resolvedDuration > 0,
          animationDuration: resolvedDuration,
          iterations,
          padding,
          multiline,
        });
        annotation = currentAnnotation;
        currentAnnotation.show();
        let previousRects = readAnnotationRects(element, multiline);

        resizeObserver = new ResizeObserver(() => {
          const nextRects = readAnnotationRects(element, multiline);
          if (
            nextRects.length === previousRects.length &&
            nextRects.every((value, index) => Math.abs(value - previousRects[index]!) < 0.5)
          ) return;
          previousRects = nextRects;
          // 已显示的标注直接 show() 会无动画校正；hide() 后再 show() 会重播。
          currentAnnotation.show();
        });

        resizeObserver.observe(element);
        resizeObserver.observe(element.offsetParent ?? document.body);
      }

      return () => {
        annotation?.remove();
        resizeObserver?.disconnect();
      };
    }, [
      shouldShow,
      action,
      color,
      strokeWidth,
      prefersReducedMotion,
      resolvedDuration,
      iterations,
      padding,
      multiline,
    ]);

    // highlight 会在文字后方涂色，需要深色文字保证可读性
    const actionTextClass = action === "highlight" ? "text-neutral-950" : "";

    return (
      <span
        ref={mergedRef}
        className={cn(
          "relative inline bg-transparent",
          actionTextClass,
          className,
        )}
        {...props}
      >
        {children}
      </span>
    );
  },
);
Highlighter.displayName = "Highlighter";

export { Highlighter };
