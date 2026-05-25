'use client';

import { TocPlugin } from '@platejs/toc/react';

import { TocElement } from '@/components/ui/toc-node';

export const TocKit = [TocPlugin.withComponent(TocElement)];
