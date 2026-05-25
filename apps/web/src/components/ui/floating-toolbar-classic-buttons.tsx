'use client';

import {
  BoldIcon,
  Code2Icon,
  ItalicIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorReadOnly } from 'platejs/react';

import { AiAssistantToolbarButton } from '@/components/editor/ai-assistant/ai-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';
import { CommentToolbarButton } from './comment-toolbar-button';
import { SuggestionToolbarButton } from './suggestion-toolbar-button';
import { ToolbarGroup, ToolbarSeparator } from './toolbar';
import { TurnIntoToolbarButton } from './turn-into-toolbar-classic-button';

export function FloatingToolbarClassicButtons() {
  const readOnly = useEditorReadOnly();

  if (readOnly) {
    return null;
  }

  return (
    <>
      <ToolbarGroup>
        <AiAssistantToolbarButton />
        <ToolbarSeparator />
        <TurnIntoToolbarButton />

        <MarkToolbarButton nodeType={KEYS.bold} tooltip="加粗 (⌘+B)">
          <BoldIcon />
        </MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.italic} tooltip="斜体 (⌘+I)">
          <ItalicIcon />
        </MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.underline} tooltip="下划线 (⌘+U)">
          <UnderlineIcon />
        </MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.strikethrough} tooltip="删除线">
          <StrikethroughIcon />
        </MarkToolbarButton>
        <MarkToolbarButton nodeType={KEYS.code} tooltip="行内代码 (⌘+E)">
          <Code2Icon />
        </MarkToolbarButton>

        <LinkToolbarButton />
        <CommentToolbarButton />
        <SuggestionToolbarButton />
        <MoreToolbarButton />
      </ToolbarGroup>
    </>
  );
}
