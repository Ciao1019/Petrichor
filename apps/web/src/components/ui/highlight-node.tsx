'use client';

import type { PlateLeafProps } from 'platejs/react';

import { PlateLeaf, useEditorReadOnly } from 'platejs/react';

import { Highlighter } from '@/components/godui/highlighter';
import {
  HIGHLIGHT_ACTION_KEY,
  HIGHLIGHT_COLOR_KEY,
  resolveHighlighterAction,
  resolveHighlighterColor,
} from '@/components/godui/highlighter-marks';
import { cn } from '@/lib/utils';

function HighlightLeafFallback({
  action,
  color,
  children,
  ...props
}: PlateLeafProps & {
  action: ReturnType<typeof resolveHighlighterAction>;
  color: string;
}) {
  return (
    <PlateLeaf
      {...props}
      as="mark"
      className={cn(
        'bg-transparent text-inherit',
        action === 'highlight' && 'rounded-sm px-0.5 text-neutral-950',
        action === 'underline' && 'underline decoration-2 underline-offset-4',
        action === 'box' && 'rounded-sm border-2 px-0.5',
        action === 'circle' && 'rounded-full border-2 px-1',
        action === 'strike-through' && 'line-through decoration-2',
        action === 'crossed-off' && 'line-through decoration-2',
      )}
      style={
        action === 'highlight'
          ? { backgroundColor: color }
          : {
              borderColor: color,
              textDecorationColor: color,
            }
      }
    >
      {children}
    </PlateLeaf>
  );
}

export function HighlightLeaf(props: PlateLeafProps) {
  const readOnly = useEditorReadOnly();
  const action = resolveHighlighterAction(props.leaf[HIGHLIGHT_ACTION_KEY]);
  const color = resolveHighlighterColor(props.leaf[HIGHLIGHT_COLOR_KEY]);

  // 编辑态避免 rough-notation 向 contenteditable 插入 SVG；前台只读再播放手绘动画
  if (!readOnly) {
    return (
      <HighlightLeafFallback {...props} action={action} color={color}>
        {props.children}
      </HighlightLeafFallback>
    );
  }

  return (
    <PlateLeaf {...props} as="span" className="bg-transparent">
      <Highlighter action={action} color={color} isView>
        {props.children}
      </Highlighter>
    </PlateLeaf>
  );
}
