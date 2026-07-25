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
          animationDuration: resolvedDuration,
          iterations,
          padding,
          multiline,
        });
        annotation = currentAnnotation;
        currentAnnotation.show();

        resizeObserver = new ResizeObserver(() => {
          currentAnnotation.hide();
          currentAnnotation.show();
        });

        resizeObserver.observe(element);
        resizeObserver.observe(document.body);
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
