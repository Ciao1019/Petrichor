"use client";

import * as React from "react";
import { motion, useReducedMotion } from "motion/react";

/* ── theme ── */
const CSS = `
.bd{
  --bd-danger:#FF3B30;
  background:transparent;
  transition:background-color .2s ease
}
.dark .bd,[data-theme="dark"] .bd{--bd-danger:#FF453A}
.bd:hover:not(:disabled){background:var(--accent)}
.dark .bd:hover:not(:disabled),[data-theme="dark"] .bd:hover:not(:disabled){
  background:color-mix(in oklab,var(--accent) 50%,transparent)
}
.bd:disabled{opacity:.5;pointer-events:none}
.bd:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--bd-danger) 35%,transparent)}`;

/* ── component ── */
export interface ButtonDeleteProps {
  /** 无障碍名称，同时作为原生 title 提示 */
  label?: string;
  /** 点击按钮时触发；是否二次确认由调用方决定 */
  onDelete?: () => void;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** 与行内其他 ghost 图标按钮同款的无边框按钮，只保留红色垃圾桶图标 */
export function ButtonDelete({
  label = "删除",
  onDelete,
  disabled = false,
  className,
  style,
}: ButtonDeleteProps) {
  const reduceMotion = useReducedMotion();

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <motion.button
        type="button"
        className={className ? `bd ${className}` : "bd"}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={(event) => {
          // 行内使用：阻止冒泡，避免触发行点击（如打开文章）
          event.stopPropagation();
          if (!disabled) onDelete?.();
        }}
        whileHover={reduceMotion || disabled ? undefined : { scale: 1.08 }}
        whileTap={reduceMotion || disabled ? undefined : { scale: 0.92 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: 8,
          border: "none",
          color: "var(--bd-danger)",
          cursor: disabled ? "default" : "pointer",
          outline: "none",
          userSelect: "none",
          ...style,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </motion.button>
    </>
  );
}

export default ButtonDelete;
