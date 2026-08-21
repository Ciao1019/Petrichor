"use client";

import type React from "react";

import { ChevronRight } from "@/components/iconimate";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion, MotionConfig } from "motion/react";
import { useState } from "react";

export interface ListItem {
  /**
   * Unique identifier for the list item
   */
  id: string;
  /**
   * Display label for the list item
   */
  label: React.ReactNode;
  /**
   * Optional icon component
   */
  icon?: React.ReactNode;
  /**
   * Nested children items
   */
  children?: ListItem[];
  /**
   * Additional metadata
   */
  metadata?: Record<string, unknown>;
  /**
   * Optional URL to navigate to
   */
  href?: string;
  /**
   * Optional click handler
   */
  onClick?: (e: React.MouseEvent) => void;
  /**
   * 懒加载场景：children 还没拉回来时也要显示展开箭头。
   * 缺省时按 children 长度推断。
   */
  hasChildren?: boolean;
  /**
   * 行首插槽（复选框、拖拽手柄等），渲染在展开箭头之前，不参与行点击。
   */
  leading?: React.ReactNode;
  /**
   * 行尾插槽（状态徽标、操作菜单等），右对齐，不参与行点击。
   */
  trailing?: React.ReactNode;
  /**
   * 展开后 children 为空时的占位内容（加载中 / 加载失败 / 空文件夹）。
   */
  emptyContent?: React.ReactNode;
  /**
   * 行容器附加类名（拖拽高亮、移动中置灰等）。
   */
  className?: string;
  /**
   * 禁用整行交互。
   */
  disabled?: boolean;
  /**
   * 包一层外层容器：dnd-kit sortable 之类需要拿到真实 DOM 节点时使用。
   * 包裹范围是「当前行 + 其子树」，与整棵子树一起移动。
   */
  renderWrapper?: (content: React.ReactNode, item: ListItem) => React.ReactNode;
  /**
   * 只指向「当前行」的 ref，不含展开的子树。
   * 拖拽命中测试要按行高判断落点，renderWrapper 拿到的矩形包含整棵子树，不能用。
   */
  rowRef?: React.Ref<HTMLDivElement>;
  /**
   * 拖拽插入指示线：before 画在行顶，after 画在行底。
   * 与「放入容器」的整行高亮（走 className）区分开，让两种落点意图一眼可辨。
   */
  dropIndicator?: "before" | "after" | null;
}

export interface NativeNestedListProps {
  items: ListItem[];
  activeId?: string;
  onItemClick?: (item: ListItem) => void;
  size?: "sm" | "md" | "lg";
  showExpandIcon?: boolean;
  defaultExpanded?: boolean;
  className?: string;
  indentSize?: number;
  /**
   * 受控展开：传入后由外部持有展开集合，配合 onExpandedChange 使用。
   * 不传则每个节点各自维护内部状态（等同上游行为）。
   */
  expandedIds?: Set<string>;
  /**
   * 展开状态变化回调。受控模式下必须由外部写回 expandedIds。
   */
  onExpandedChange?: (id: string, expanded: boolean, item: ListItem) => void;
}

const sizeVariants = {
  sm: "h-8 text-xs px-2",
  md: "h-10 text-sm px-3",
  lg: "h-12 text-base px-4",
};

const iconSizeVariants = {
  sm: "h-3 w-3",
  md: "h-4 w-4",
  lg: "h-5 w-5",
};

interface NestedItemProps {
  item: ListItem;
  level: number;
  activeId?: string;
  onItemClick?: (item: ListItem) => void;
  size: "sm" | "md" | "lg";
  showExpandIcon: boolean;
  defaultExpanded: boolean;
  indentSize: number;
  expandedIds?: Set<string>;
  onExpandedChange?: (id: string, expanded: boolean, item: ListItem) => void;
}

function NestedItem({
  item,
  level,
  activeId,
  onItemClick,
  size,
  showExpandIcon,
  defaultExpanded,
  indentSize,
  expandedIds,
  onExpandedChange,
}: NestedItemProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const isControlled = expandedIds !== undefined;
  const isExpanded = isControlled ? expandedIds.has(item.id) : internalExpanded;
  const hasChildren = item.hasChildren ?? Boolean(item.children && item.children.length > 0);
  const isActive = activeId === item.id;

  const handleClick = (e: React.MouseEvent) => {
    if (item.disabled) {
      e.preventDefault();
      return;
    }
    if (hasChildren) {
      e.preventDefault();
      if (!isControlled) setInternalExpanded(!isExpanded);
      onExpandedChange?.(item.id, !isExpanded, item);
    }
    onItemClick?.(item);
    item.onClick?.(e);
  };

  const Comp = item.href ? "a" : "span";
  const props = item.href ? { href: item.href } : {};

  const row = (
    <>
      <motion.div
        ref={item.rowRef}
        initial={false}
        whileHover={item.disabled ? undefined : { x: 4 }}
        transition={{
          type: "spring",
          stiffness: 300,
          damping: 25,
        }}
        style={{ paddingLeft: `${level * indentSize}px` }}
        className={cn(
          "relative flex items-center rounded-md transition-colors duration-300 hover:bg-accent/50",
          item.disabled && "opacity-60",
          item.className
        )}
      >
        {item.dropIndicator ? (
          <div
            aria-hidden="true"
            className={cn(
              // 贴在行内边缘而不是行外：子树容器带 overflow:hidden，画到行外会被裁掉。
              "pointer-events-none absolute inset-x-0 z-10 h-0.5 rounded-full bg-primary",
              item.dropIndicator === "before" ? "top-0" : "bottom-0"
            )}
          >
            <span className="absolute left-0 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary" />
          </div>
        ) : null}
        {item.leading ? (
          <div className="flex shrink-0 items-center pl-1">{item.leading}</div>
        ) : null}
        <motion.div
          whileTap={item.disabled ? undefined : { scale: 0.98 }}
          transition={{ type: "spring", stiffness: 400, damping: 17 }}
          className="min-w-0 flex-1"
        >
          <Button
            variant="ghost"
            size="default"
            asChild={!!item.href}
            disabled={item.disabled && !item.href}
            aria-expanded={hasChildren ? isExpanded : undefined}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              sizeVariants[size],
              "w-full justify-start gap-2 relative overflow-hidden rounded-md",
              "hover:bg-transparent dark:hover:bg-transparent",
              isActive && "font-medium bg-accent/30"
            )}
            onClick={handleClick}
          >
            <Comp className="flex min-w-0 items-center gap-2" {...props}>
              {showExpandIcon && hasChildren && (
                <motion.div
                  initial={false}
                  animate={{ rotate: isExpanded ? 90 : 0 }}
                  transition={{
                    type: "spring",
                    stiffness: 300,
                    damping: 20,
                  }}
                  className="flex-shrink-0"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={iconSizeVariants[size]}
                  />
                </motion.div>
              )}
              {showExpandIcon && !hasChildren && (
                <div className={cn(iconSizeVariants[size], "flex-shrink-0")} />
              )}
              {item.icon && (
                <div className="flex-shrink-0">{item.icon}</div>
              )}
              <span className="truncate">{item.label}</span>
            </Comp>
          </Button>
        </motion.div>

        {item.trailing ? (
          <div className="flex shrink-0 items-center gap-1 pr-1">{item.trailing}</div>
        ) : null}

        <AnimatePresence>
          {isActive && !item.trailing && (
            <motion.div
              aria-hidden="true"
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.5, opacity: 0 }}
              transition={{
                type: "spring",
                stiffness: 500,
                damping: 30,
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-1.5 h-1.5 bg-foreground rounded-full"
            />
          )}
        </AnimatePresence>
      </motion.div>

      {/* Nested children */}
      <AnimatePresence initial={false}>
        {hasChildren && isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              height: {
                type: "spring",
                stiffness: 300,
                damping: 25,
              },
              opacity: {
                duration: 0.2,
              },
            }}
            style={{ overflow: "hidden" }}
          >
            {item.children && item.children.length > 0 ? (
              <ul className="list-none">
                {item.children.map((child) => (
                  <NestedItem
                    key={child.id}
                    item={child}
                    level={level + 1}
                    activeId={activeId}
                    onItemClick={onItemClick}
                    size={size}
                    showExpandIcon={showExpandIcon}
                    defaultExpanded={defaultExpanded}
                    indentSize={indentSize}
                    expandedIds={expandedIds}
                    onExpandedChange={onExpandedChange}
                  />
                ))}
              </ul>
            ) : (
              item.emptyContent ?? null
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );

  return <li className="list-none">{item.renderWrapper ? item.renderWrapper(row, item) : row}</li>;
}

export function NativeNestedList({
  items,
  activeId,
  onItemClick,
  size = "md",
  showExpandIcon = true,
  defaultExpanded = false,
  className,
  indentSize = 16,
  expandedIds,
  onExpandedChange,
}: NativeNestedListProps) {
  return (
    <MotionConfig reducedMotion="user">
      <ul className={cn("w-full space-y-1 list-none", className)}>
        {items.map((item) => (
          <NestedItem
            key={item.id}
            item={item}
            level={0}
            activeId={activeId}
            onItemClick={onItemClick}
            size={size}
            showExpandIcon={showExpandIcon}
            defaultExpanded={defaultExpanded}
            indentSize={indentSize}
            expandedIds={expandedIds}
            onExpandedChange={onExpandedChange}
          />
        ))}
      </ul>
    </MotionConfig>
  );
}
