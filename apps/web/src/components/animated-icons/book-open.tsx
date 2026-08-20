"use client";

import type { Variants } from "motion/react";
import { motion, useAnimation, useReducedMotion } from "motion/react";
import type { HTMLAttributes } from "react";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/utils";

export interface BookOpenIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface BookOpenIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const LEFT_PAGE_VARIANTS: Variants = {
  normal: { rotateY: 0 },
  animate: {
    rotateY: [0, 15, 0],
    transition: {
      duration: 0.5,
      ease: "easeInOut",
    },
  },
};

const RIGHT_PAGE_VARIANTS: Variants = {
  normal: { rotateY: 0 },
  animate: {
    rotateY: [0, -15, 0],
    transition: {
      duration: 0.5,
      ease: "easeInOut",
    },
  },
};

const BookOpenIcon = forwardRef<BookOpenIconHandle, BookOpenIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const reducedMotion = useReducedMotion() ?? false;
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;

      return {
        startAnimation: () => {
          if (reducedMotion) return;
          controls.start("animate");
        },
        stopAnimation: () => controls.start("normal"),
      };
    });

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseEnter?.(e);
        } else if (!reducedMotion) {
          controls.start("animate");
        }
      },
      [controls, onMouseEnter, reducedMotion]
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseLeave?.(e);
        } else {
          controls.start("normal");
        }
      },
      [controls, onMouseLeave]
    );

    return (
      <div
        className={cn("flex items-center justify-center", className)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        {...props}
      >
        <svg
          fill="none"
          height={size}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          style={{ width: size, height: size }}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <motion.g
            animate={controls}
            initial="normal"
            style={{ originX: 1, originY: 0.5 }}
            variants={LEFT_PAGE_VARIANTS}
          >
            <path d="M12 6.04168C10.4077 4.61656 8.30506 3.75 6 3.75C4.94809 3.75 3.93834 3.93046 3 4.26212V18.5121C3.93834 18.1805 4.94809 18 6 18C8.30506 18 10.4077 18.8666 12 20.2917" />
          </motion.g>
          <motion.g
            animate={controls}
            initial="normal"
            style={{ originX: 0, originY: 0.5 }}
            variants={RIGHT_PAGE_VARIANTS}
          >
            <path d="M12 6.04168C13.5923 4.61656 15.6949 3.75 18 3.75C19.0519 3.75 20.0617 3.93046 21 4.26212V18.5121C20.0617 18.1805 19.0519 18 18 18C15.6949 18 13.5923 18.8666 12 20.2917" />
          </motion.g>
          <path d="M12 6.04168V20.2917" />
        </svg>
      </div>
    );
  }
);

BookOpenIcon.displayName = "BookOpenIcon";

export { BookOpenIcon };
