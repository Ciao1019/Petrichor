'use client';

import type { TCaptionProps, TImageElement, TResizableProps } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { NodeApi } from 'platejs';
import { SlateElement } from 'platejs/static';

import { useSignedUrl } from '@/hooks/use-signed-url';
import { cn } from '@/lib/utils';

export function ImageElementStatic(
  props: SlateElementProps<TImageElement & TCaptionProps & TResizableProps>
) {
  const { align = 'center', caption, url, width } = props.element;

  // 公开分享页：使用 isPublic=true，通过无鉴权接口获取签名 URL（防盗链）
  const signedUrl = useSignedUrl(url, true);

  return (
    <SlateElement {...props} className="py-2.5">
      <figure className="group relative m-0 inline-block" style={{ width }}>
        <div
          className="relative min-w-[92px] max-w-full"
          style={{ textAlign: align }}
        >
          <img
            className={cn(
              'w-full max-w-full cursor-default object-cover px-0',
              'rounded-sm'
            )}
            alt={(props.attributes as any).alt}
            src={signedUrl ?? url}
          />
          {caption && (
            <figcaption
              className="mx-auto mt-2 h-[24px] max-w-full"
              style={{ textAlign: 'center' }}
            >
              {NodeApi.string(caption[0])}
            </figcaption>
          )}
        </div>
      </figure>
      {props.children}
    </SlateElement>
  );
}
