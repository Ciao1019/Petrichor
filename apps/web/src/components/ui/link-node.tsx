'use client';

import type { TInlineSuggestionData, TLinkElement } from 'platejs';
import type { PlateElementProps } from 'platejs/react';
import type { MouseEventHandler } from 'react';

import { getLinkAttributes } from '@platejs/link';
import { SuggestionPlugin } from '@platejs/suggestion/react';
import { PlateElement, useReadOnly } from 'platejs/react';
import { useInRouterContext, useLinkClickHandler } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { wikiScribbleStyle } from '@/components/markdown/wiki-scribble';

export function LinkElement(props: PlateElementProps<TLinkElement>) {
  const readOnly = useReadOnly();
  const inRouter = useInRouterContext();
  const publicWikiLink = /^\/wiki\/[^/]+\/[^/]+$/.test(props.element.url);

  // 只读站内 Wiki 链接走 SPA；编辑态和无 Router 的预览保留原有行为。
  if (publicWikiLink && readOnly && inRouter) {
    return <RoutedWikiLinkElement {...props} />;
  }
  return <LinkElementContent {...props} />;
}

function RoutedWikiLinkElement(props: PlateElementProps<TLinkElement>) {
  const navigate = useLinkClickHandler<HTMLAnchorElement>(props.element.url, {
    target: props.element.target ?? '_self',
  });

  const onClick: MouseEventHandler<HTMLAnchorElement> = (event) => {
    if (typeof props.attributes?.onClick === 'function') {
      props.attributes.onClick(event);
    }
    // React Router 保留修饰键、中键和新窗口语义；下载链接仍交给浏览器。
    if (!event.defaultPrevented && !event.currentTarget.hasAttribute('download')) {
      navigate(event);
    }
  };

  return <LinkElementContent {...props} onNavigate={onClick} />;
}

function LinkElementContent({
  onNavigate,
  ...props
}: PlateElementProps<TLinkElement> & { onNavigate?: MouseEventHandler<HTMLAnchorElement> }) {
  const publicWikiLink = /^\/wiki\/[^/]+\/[^/]+$/.test(props.element.url);
  const suggestionData = props.editor
    .getApi(SuggestionPlugin)
    .suggestion.suggestionData(props.element) as
    | TInlineSuggestionData
    | undefined;

  return (
    <PlateElement
      {...props}
      as="a"
      className={cn(
        'font-medium text-primary underline decoration-primary underline-offset-4',
        suggestionData?.type === 'remove' && 'bg-red-100 text-red-700',
        suggestionData?.type === 'insert' && 'bg-emerald-100 text-emerald-700'
      )}
      attributes={{
        ...props.attributes,
        ...getLinkAttributes(props.editor, props.element),
        ...(publicWikiLink ? { style: { ...wikiScribbleStyle(props.element.url), textDecoration: 'none' }, target: props.element.target ?? '_self' } : {}),
        ...(onNavigate ? { onClick: onNavigate } : {}),
        onMouseOver: (e) => {
          e.stopPropagation();
        },
      }}
    >
      {props.children}
    </PlateElement>
  );
}
