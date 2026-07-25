import type { HighlighterAction } from "@/components/godui/highlighter";

/** Plate 文本叶上存储的手绘高亮样式 */
export const HIGHLIGHT_ACTION_KEY = "highlightAction" as const;
/** Plate 文本叶上存储的手绘高亮颜色 */
export const HIGHLIGHT_COLOR_KEY = "highlightColor" as const;

export const DEFAULT_HIGHLIGHTER_ACTION: HighlighterAction = "highlight";
export const DEFAULT_HIGHLIGHTER_COLOR = "#ffd1dc";

export const HIGHLIGHTER_ACTIONS = [
  { value: "highlight", label: "荧光笔" },
  { value: "underline", label: "手绘下划线" },
  { value: "box", label: "方框" },
  { value: "circle", label: "圆圈" },
] as const satisfies readonly {
  value: HighlighterAction;
  label: string;
}[];

export type ToolbarHighlighterAction =
  (typeof HIGHLIGHTER_ACTIONS)[number]["value"];

export const HIGHLIGHTER_COLORS: { name: string; value: string }[] = [
  { name: "粉", value: "#ffd1dc" },
  { name: "黄", value: "#fef08a" },
  { name: "绿", value: "#bbf7d0" },
  { name: "蓝", value: "#bfdbfe" },
  { name: "紫", value: "#e9d5ff" },
  { name: "橙", value: "#fed7aa" },
  { name: "红", value: "#fca5a5" },
  { name: "青", value: "#a5f3fc" },
];

export function resolveHighlighterAction(
  value: unknown,
): HighlighterAction {
  if (
    typeof value === "string" &&
    HIGHLIGHTER_ACTIONS.some((item) => item.value === value)
  ) {
    return value as HighlighterAction;
  }
  return DEFAULT_HIGHLIGHTER_ACTION;
}

export function resolveHighlighterColor(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return DEFAULT_HIGHLIGHTER_COLOR;
}
