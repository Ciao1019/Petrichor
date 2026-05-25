'use client';

import type { ExtendConfig, Path } from 'platejs';

import {
  type BaseCommentConfig,
  BaseCommentPlugin,
  getDraftCommentKey,
} from '@platejs/comment';
import { isSlateString } from 'platejs';
import { toTPlatePlugin } from 'platejs/react';

import { CommentLeaf } from '@/components/ui/comment-node';

type CommentConfig = ExtendConfig<
  BaseCommentConfig,
  {
    activeId: string | null;
    commentingBlock: Path | null;
    hoverId: string | null;
    uniquePathMap: Map<string, Path>;
  }
>;

export const commentPlugin = toTPlatePlugin<CommentConfig>(BaseCommentPlugin, {
  handlers: {
    onClick: ({ api, event, setOption, type }) => {
      const leafElement =
        event.target instanceof HTMLElement
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
      if (!leafElement) {
        return;
      }
      if (leafElement.closest('[data-plate-prevent-overlay]')) {
        return;
      }

      let leaf = leafElement;
      let isSet = false;

      const unsetActiveSuggestion = () => {
        setOption('activeId', null);
        isSet = true;
      };

      if (!isSlateString(leaf)) unsetActiveSuggestion();

      while (leaf.parentElement) {
        if (leaf.classList.contains(`slate-${type}`)) {
          const commentsEntry = api.comment!.node();

          if (!commentsEntry) {
            unsetActiveSuggestion();

            break;
          }

          const id = api.comment!.nodeId(commentsEntry[0]);

          setOption('activeId', id ?? null);
          isSet = true;

          break;
        }

        leaf = leaf.parentElement;
      }

      if (!isSet) {
        unsetActiveSuggestion();
      }
    },
  },
  options: {
    activeId: null,
    commentingBlock: null,
    hoverId: null,
    uniquePathMap: new Map(),
  },
})
  .extendTransforms(
    ({
      editor,
      setOption,
      tf: {
        comment: { setDraft },
      },
    }) => ({
      setDraft: () => {
        editor.tf.unsetNodes([getDraftCommentKey()], {
          at: [],
          mode: 'lowest',
          match: (n) =>
            typeof n === 'object' &&
            n !== null &&
            getDraftCommentKey() in n,
        });

        if (editor.api.isCollapsed()) {
          const blockEntry = editor.api.block();
          if (!blockEntry) {
            return;
          }
          editor.tf.select(blockEntry[1]);
        }

        setDraft();

        editor.tf.collapse();
        setOption('activeId', getDraftCommentKey());
        if (!editor.selection) {
          setOption('commentingBlock', null);
          return;
        }

        setOption('commentingBlock', editor.selection.focus.path.slice(0, 1));
      },
    })
  )
  .configure({
    node: { component: CommentLeaf },
    shortcuts: {
      setDraft: { keys: 'mod+shift+m' },
    },
  });

export const CommentKit = [commentPlugin];
