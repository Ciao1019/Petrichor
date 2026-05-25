'use client';

import { MessageSquareTextIcon } from 'lucide-react';
import { useEditorRef } from 'platejs/react';

import { commentPlugin } from '@/components/editor/plugins/comment-kit';

import { ToolbarButton } from './toolbar';

export function CommentToolbarButton() {
  const editor = useEditorRef();

  return (
    <ToolbarButton
      onPointerDown={(event) => {
        event.preventDefault();
        editor.getTransforms(commentPlugin).comment.setDraft();
      }}
      onClick={(event) => {
        event.preventDefault();
      }}
      data-plate-prevent-overlay
      tooltip="评论"
    >
      <MessageSquareTextIcon />
    </ToolbarButton>
  );
}
