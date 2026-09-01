'use client';

import type { ComponentProps } from 'react';
import { BlockSelectionPlugin } from '@platejs/selection/react';
import { getPluginTypes, KEYS } from 'platejs';

import { BlockSelection } from '@/components/ui/block-selection';

export const BlockSelectionKit = [
  BlockSelectionPlugin.configure(({ editor }) => ({
    options: {
      enableContextMenu: true,
      isSelectable: (element) =>
        !getPluginTypes(editor, [KEYS.column, KEYS.codeLine, KEYS.td]).includes(
          element.type
        ),
    },
    render: {
      belowRootNodes: (props) => {
        if (!props.attributes.className?.includes('slate-selectable'))
          return null;

        // Plate 的插件上下文会携带更具体的泛型；运行时 props 与组件契约一致。
        return <BlockSelection {...(props as unknown as ComponentProps<typeof BlockSelection>)} />;
      },
    },
  })),
];
