'use client';

import type { TCaptionProps, TImageElement, TResizableProps } from 'platejs';
import type { SlateElementProps } from 'platejs/static';

import { NodeApi } from 'platejs';
import { SlateElement } from 'platejs/static';

import { useSignedUrl } from '@/hooks/use-signed-url';
import { cn } from '@/lib/utils';

import { protectedImageProps } from './protected-media';

export function ImageElementStatic(
  props: SlateElementProps<TImageElement & TCaptionProps & TResizableProps>
) {
  const { align = 'center', caption, url, width } = props.element;
  const attributes = props.attributes as Record<string, unknown>;
  const alt = typeof attributes.alt === 'string' ? attributes.alt : undefined;

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
            {...protectedImageProps}
            className={cn(
              'w-full max-w-full cursor-default object-cover px-0',
              'rounded-sm'
            )}
            alt={alt}
            src={signedUrl ?? url}
          />
          {caption?.[0] && (
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
