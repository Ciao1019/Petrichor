'use client';

import type { PlateElementProps } from 'platejs/react';

import { PlateElement } from 'platejs/react';

import { cn } from '@/lib/utils';

export function ParagraphElement(props: PlateElementProps) {
  return (
    <PlateElement
      {...props}
      className={cn('m-0 px-0 py-1')}
      attributes={{
        ...props.attributes,
        'data-article-block': 'paragraph',
      }}
    >
      {props.children}
    </PlateElement>
  );
}
