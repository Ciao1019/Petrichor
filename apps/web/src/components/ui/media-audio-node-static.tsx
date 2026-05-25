'use client';

import type { TAudioElement } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { SlateElement } from 'platejs/static';

import { useSignedUrl } from '@/hooks/use-signed-url';

export function AudioElementStatic(props: SlateElementProps<TAudioElement>) {
  const url = props.element.url;
  const signedUrl = useSignedUrl(url, true);

  return (
    <SlateElement {...props} className="mb-1">
      <figure className="group relative cursor-default">
        <div className="h-16">
          <audio className="size-full" src={signedUrl ?? url} controls />
        </div>
      </figure>
      {props.children}
    </SlateElement>
  );
}
