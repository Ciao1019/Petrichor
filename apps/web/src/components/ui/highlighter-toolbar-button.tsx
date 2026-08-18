'use client';

import * as React from 'react';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import {
  CircleIcon,
  EraserIcon,
  HighlighterIcon,
  SquareIcon,
  UnderlineIcon,
} from '@/components/iconimate';
import { KEYS } from 'platejs';
import { useEditorRef, useEditorSelector } from 'platejs/react';

import type { HighlighterAction } from '@/components/godui/highlighter';
import {
  DEFAULT_HIGHLIGHTER_ACTION,
  DEFAULT_HIGHLIGHTER_COLOR,
  HIGHLIGHT_ACTION_KEY,
  HIGHLIGHT_COLOR_KEY,
  HIGHLIGHTER_ACTIONS,
  HIGHLIGHTER_COLORS,
  resolveHighlighterAction,
  resolveHighlighterColor,
  type ToolbarHighlighterAction,
} from '@/components/godui/highlighter-marks';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

import { ToolbarButton } from './toolbar';

const ACTION_ICONS: Record<ToolbarHighlighterAction, React.ReactNode> = {
  highlight: <HighlighterIcon className="size-4" />,
  underline: <UnderlineIcon className="size-4" />,
  box: <SquareIcon className="size-4" />,
  circle: <CircleIcon className="size-4" />,
};

export function HighlighterToolbarButton({
  tooltip = '手绘高亮',
  ...props
}: DropdownMenuProps & { tooltip?: string }) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  const highlightActive = useEditorSelector(
    (ed) => !!ed.api.mark(KEYS.highlight),
    []
  );
  const currentAction = useEditorSelector(
    (ed) => resolveHighlighterAction(ed.api.mark(HIGHLIGHT_ACTION_KEY)),
    []
  );
  const currentColor = useEditorSelector(
    (ed) => resolveHighlighterColor(ed.api.mark(HIGHLIGHT_COLOR_KEY)),
    []
  );

  const [action, setAction] = React.useState<HighlighterAction>(
    DEFAULT_HIGHLIGHTER_ACTION
  );
  const [color, setColor] = React.useState(DEFAULT_HIGHLIGHTER_COLOR);

  React.useEffect(() => {
    if (!open) return;
    setAction(highlightActive ? currentAction : DEFAULT_HIGHLIGHTER_ACTION);
    setColor(highlightActive ? currentColor : DEFAULT_HIGHLIGHTER_COLOR);
  }, [open, highlightActive, currentAction, currentColor]);

  const applyHighlight = React.useCallback(
    (nextAction: HighlighterAction, nextColor: string) => {
      if (!editor.selection) return;

      editor.tf.select(editor.selection);
      editor.tf.focus();
      editor.tf.addMarks({
        [KEYS.highlight]: true,
        [HIGHLIGHT_ACTION_KEY]: nextAction,
        [HIGHLIGHT_COLOR_KEY]: nextColor,
      });
    },
    [editor]
  );

  const clearHighlight = React.useCallback(() => {
    if (!editor.selection) return;

    editor.tf.select(editor.selection);
    editor.tf.focus();
    editor.tf.removeMarks(KEYS.highlight);
    editor.tf.removeMarks(HIGHLIGHT_ACTION_KEY);
    editor.tf.removeMarks(HIGHLIGHT_COLOR_KEY);
    setOpen(false);
  }, [editor]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          pressed={open || highlightActive}
          tooltip={tooltip}
          className="relative"
        >
          <HighlighterIcon />
          <span
            className="absolute bottom-0.5 left-1/2 size-1.5 -translate-x-1/2 rounded-full"
            style={{ backgroundColor: highlightActive ? currentColor : color }}
          />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="ignore-click-outside/toolbar w-56"
        align="start"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-semibold">
            标注样式
          </DropdownMenuLabel>
          {HIGHLIGHTER_ACTIONS.map((item) => (
            <DropdownMenuItem
              key={item.value}
              className={cn(action === item.value && 'bg-accent')}
              onSelect={(event) => {
                // 选样式后继续选颜色，不要立刻关菜单
                event.preventDefault();
                setAction(item.value);
                applyHighlight(item.value, color);
              }}
            >
              {ACTION_ICONS[item.value]}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-semibold">
            颜色
          </DropdownMenuLabel>
          <div className="grid grid-cols-4 gap-1.5 px-2 pb-1.5">
            {HIGHLIGHTER_COLORS.map((item) => (
              <button
                key={item.value}
                type="button"
                title={item.name}
                aria-label={item.name}
                className={cn(
                  'size-7 rounded-md border border-black/10 shadow-sm transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  color === item.value && 'ring-ring ring-2 ring-offset-1'
                )}
                style={{ backgroundColor: item.value }}
                onClick={() => {
                  setColor(item.value);
                  applyHighlight(action, item.value);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </DropdownMenuGroup>

        {highlightActive && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem className="gap-2" onSelect={clearHighlight}>
                <EraserIcon className="size-4" />
                清除高亮
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
