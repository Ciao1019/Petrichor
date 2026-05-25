'use client';

import * as React from 'react';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';
import type { TElement } from 'platejs';

import { DropdownMenuItemIndicator } from '@radix-ui/react-dropdown-menu';
import {
  CheckIcon,
  FileCodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  Heading4Icon,
  Heading5Icon,
  Heading6Icon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  QuoteIcon,
  SquareIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorRef, useSelectionFragmentProp } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getBlockType, setBlockType } from '@/components/editor/transforms-classic';

import { ToolbarButton, ToolbarMenuGroup } from './toolbar';

const turnIntoItems = [
  { icon: <PilcrowIcon />, label: '正文', value: KEYS.p },
  { icon: <Heading1Icon />, label: '标题 1', value: 'h1' },
  { icon: <Heading2Icon />, label: '标题 2', value: 'h2' },
  { icon: <Heading3Icon />, label: '标题 3', value: 'h3' },
  { icon: <Heading4Icon />, label: '标题 4', value: 'h4' },
  { icon: <Heading5Icon />, label: '标题 5', value: 'h5' },
  { icon: <Heading6Icon />, label: '标题 6', value: 'h6' },
  { icon: <ListIcon />, label: '无序列表', value: KEYS.ulClassic },
  { icon: <ListOrderedIcon />, label: '有序列表', value: KEYS.olClassic },
  { icon: <SquareIcon />, label: '任务列表', value: KEYS.taskList },
  { icon: <FileCodeIcon />, label: '代码块', value: KEYS.codeBlock },
  { icon: <QuoteIcon />, label: '引用', value: KEYS.blockquote },
];

export function TurnIntoToolbarButton(props: DropdownMenuProps) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);
  const value = useSelectionFragmentProp({
    defaultValue: KEYS.p,
    getProp: (node) => getBlockType(node as TElement),
  });
  const selectedItem = React.useMemo(
    () => turnIntoItems.find((item) => item.value === (value ?? KEYS.p)) ?? turnIntoItems[0],
    [value]
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          className="min-w-[125px]"
          pressed={open}
          tooltip="切换块类型"
          isDropdown
        >
          {selectedItem.label}
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="ignore-click-outside/toolbar min-w-0"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          editor.tf.focus();
        }}
        align="start"
      >
        <ToolbarMenuGroup
          value={value}
          onValueChange={(type) => setBlockType(editor, type)}
          label="切换为"
        >
          {turnIntoItems.map(({ icon, label, value: itemValue }) => (
            <DropdownMenuRadioItem
              key={itemValue}
              className="min-w-[180px] pl-2 *:first:[span]:hidden"
              value={itemValue}
            >
              <span className="pointer-events-none absolute right-2 flex size-3.5 items-center justify-center">
                <DropdownMenuItemIndicator>
                  <CheckIcon />
                </DropdownMenuItemIndicator>
              </span>
              {icon}
              {label}
            </DropdownMenuRadioItem>
          ))}
        </ToolbarMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
