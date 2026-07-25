import type { SlateLeafProps } from 'platejs/static';

import { SlateLeaf } from 'platejs/static';

import {
  HIGHLIGHT_ACTION_KEY,
  HIGHLIGHT_COLOR_KEY,
  resolveHighlighterAction,
  resolveHighlighterColor,
} from '@/components/godui/highlighter-marks';
import { cn } from '@/lib/utils';

/** 静态渲染无 rough-notation，用近似样式兜底 */
export function HighlightLeafStatic(props: SlateLeafProps) {
  const action = resolveHighlighterAction(props.leaf[HIGHLIGHT_ACTION_KEY]);
  const color = resolveHighlighterColor(props.leaf[HIGHLIGHT_COLOR_KEY]);

  return (
    <SlateLeaf
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
      {props.children}
    </SlateLeaf>
  );
}
