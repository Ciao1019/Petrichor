'use client';

import * as React from 'react';

import {
  type FloatingToolbarState,
  flip,
  offset,
  shift,
  useFloatingToolbar,
  useFloatingToolbarState,
} from '@platejs/floating';
import { useComposedRef } from '@udecode/cn';
import { useEditorId, useEventEditorValue } from 'platejs/react';

import { cn } from '@/lib/utils';

import { Toolbar } from './toolbar';

export function FloatingToolbar({
  children,
  className,
  state,
  ...props
}: React.ComponentProps<typeof Toolbar> & {
  state?: FloatingToolbarState;
}) {
  const editorId = useEditorId();
  const focusedEditorId = useEventEditorValue('focus');
  const floatingToolbarState = useFloatingToolbarState({
    editorId,
    focusedEditorId,
    ...state,
    floatingOptions: {
      middleware: [
        offset(12),
        flip({ padding: 12 }),
        // shift 让工具栏在水平方向上自动避开视口边缘，避免被侧栏 / 边界遮挡
        shift({ padding: 12 }),
      ],
      placement: 'top',
      ...state?.floatingOptions,
    },
  });
  const { clickOutsideRef, hidden, props: rootProps, ref: floatingRef } =
    useFloatingToolbar(floatingToolbarState);
  const ref = useComposedRef<HTMLDivElement>(props.ref, floatingRef);

  if (hidden) return null;

  return (
    <div ref={clickOutsideRef}>
      <Toolbar
        {...props}
        {...rootProps}
        ref={ref}
        className={cn(
          'scrollbar-hide absolute z-50 max-w-[80vw] overflow-x-auto whitespace-nowrap rounded-md border bg-popover p-1 opacity-100 shadow-md',
          className
        )}
      >
        {children}
      </Toolbar>
    </div>
  );
}
