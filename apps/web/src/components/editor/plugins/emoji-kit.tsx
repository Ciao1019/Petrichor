'use client';

import data from '@emoji-mart/data';
import type { EmojiMartData } from '@emoji-mart/data';
import { EmojiInputPlugin, EmojiPlugin } from '@platejs/emoji/react';

import { EmojiInputElement } from '@/components/ui/emoji-node';

export const EmojiKit = [
  EmojiPlugin.configure({
    options: {
      data: data as EmojiMartData,
    },
  }),
  EmojiInputPlugin.withComponent(EmojiInputElement),
];
