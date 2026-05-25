'use client';

import * as React from 'react';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import {
  KeyboardIcon,
  MoreHorizontalIcon,
  SubscriptIcon,
  SuperscriptIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorRef } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { ToolbarButton } from './toolbar';

function toggleSuper(editor: ReturnType<typeof useEditorRef>) {
  editor.tf.toggleMark(KEYS.sup, { remove: KEYS.sub });
  editor.tf.focus();
}

function toggleSub(editor: ReturnType<typeof useEditorRef>) {
  editor.tf.toggleMark(KEYS.sub, { remove: KEYS.sup });
  editor.tf.focus();
}

export function MoreToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton pressed={open} tooltip="更多">
          <MoreHorizontalIcon />
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="ignore-click-outside/toolbar flex min-w-[180px] flex-col"
        align="start"
      >
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => {
              editor.tf.toggleMark(KEYS.kbd);
              editor.tf.collapse({ edge: 'end' });
              editor.tf.focus();
            }}
          >
            <KeyboardIcon />
            键盘输入
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => toggleSuper(editor)}>
            <SuperscriptIcon />
            上标
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => toggleSub(editor)}>
            <SubscriptIcon />
            下标
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
