'use client';

import { MentionInputPlugin, MentionPlugin } from '@platejs/mention/react';

import { MentionElement, MentionInputElement } from '@/components/ui/mention-node';

export const MentionKit = [
  MentionPlugin.withComponent(MentionElement),
  MentionInputPlugin.withComponent(MentionInputElement),
];
