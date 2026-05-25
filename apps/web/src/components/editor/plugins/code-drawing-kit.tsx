'use client';

import { CodeDrawingPlugin } from '@platejs/code-drawing/react';

import { CodeDrawingElement } from '@/components/ui/code-drawing-node';

export const CodeDrawingKit = [
  CodeDrawingPlugin.withComponent(CodeDrawingElement),
];
