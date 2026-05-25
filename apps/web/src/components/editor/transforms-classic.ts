'use client';

import type { PlateEditor } from 'platejs/react';

import { insertCallout } from '@platejs/callout';
import { insertCodeBlock, toggleCodeBlock } from '@platejs/code-block';
import { insertCodeDrawing } from '@platejs/code-drawing';
import { insertDate } from '@platejs/date';
import { insertColumnGroup, toggleColumnGroup } from '@platejs/layout';
import { triggerFloatingLink } from '@platejs/link/react';
import { toggleList } from '@platejs/list-classic';
import { insertEquation, insertInlineEquation } from '@platejs/math';
import {
  insertAudioPlaceholder,
  insertFilePlaceholder,
  insertMedia,
  insertVideoPlaceholder,
} from '@platejs/media';
import { TablePlugin } from '@platejs/table/react';
import { insertToc } from '@platejs/toc';
import { type Path, type TElement, KEYS, PathApi } from 'platejs';

const ACTION_THREE_COLUMNS = 'action_three_columns';

function toggleClassicList(editor: PlateEditor, type: string) {
  toggleList(editor, { type: editor.getType(type) });
}

function setTextBlock(editor: PlateEditor, type: string, at?: Path) {
  if (at) {
    editor.tf.setNodes({ type }, { at });
    return;
  }
  const entries = editor.api.blocks({ mode: 'lowest' });
  entries.forEach(([, path]) => {
    editor.tf.setNodes({ type }, { at: path });
  });
}

const insertBlockMap: Record<
  string,
  (editor: PlateEditor, type: string) => void
> = {
  [KEYS.ulClassic]: (editor) => toggleClassicList(editor, KEYS.ulClassic),
  [KEYS.olClassic]: (editor) => toggleClassicList(editor, KEYS.olClassic),
  [KEYS.taskList]: (editor) => toggleClassicList(editor, KEYS.taskList),
  [ACTION_THREE_COLUMNS]: (editor) =>
    insertColumnGroup(editor, { columns: 3, select: true }),
  [KEYS.audio]: (editor) => insertAudioPlaceholder(editor, { select: true }),
  [KEYS.callout]: (editor) => insertCallout(editor, { select: true }),
  [KEYS.codeBlock]: (editor) => insertCodeBlock(editor, { select: true }),
  [KEYS.codeDrawing]: (editor) =>
    insertCodeDrawing(editor, {}, { select: true }),
  [KEYS.equation]: (editor) => insertEquation(editor, { select: true }),
  [KEYS.file]: (editor) => insertFilePlaceholder(editor, { select: true }),
  [KEYS.img]: (editor) =>
    insertMedia(editor, { select: true, type: KEYS.img }),
  [KEYS.mediaEmbed]: (editor) =>
    insertMedia(editor, { select: true, type: KEYS.mediaEmbed }),
  [KEYS.table]: (editor) =>
    editor.getTransforms(TablePlugin).insert.table({}, { select: true }),
  [KEYS.toc]: (editor) => insertToc(editor, { select: true }),
  [KEYS.toggle]: (editor) => {
    editor.tf.insertNodes(
      { type: editor.getType(KEYS.toggle), children: [{ text: '' }] },
      { select: true }
    );
  },
  [KEYS.video]: (editor) => insertVideoPlaceholder(editor, { select: true }),
};

const insertInlineMap: Record<
  string,
  (editor: PlateEditor, type: string) => void
> = {
  [KEYS.date]: (editor) => insertDate(editor, { select: true }),
  [KEYS.inlineEquation]: (editor) =>
    insertInlineEquation(editor, '', { select: true }),
  [KEYS.link]: (editor) => triggerFloatingLink(editor, { focused: true }),
};

export function insertBlock(editor: PlateEditor, type: string) {
  if (type in insertBlockMap) {
    insertBlockMap[type](editor, type);
  } else {
    const path = editor.api.block()?.[1];
    if (path) {
      editor.tf.insertNodes(
        { type: editor.getType(type), children: [{ text: '' }] },
        { at: PathApi.next(path), select: true }
      );
    }
  }
}

export function insertInlineElement(editor: PlateEditor, type: string) {
  if (insertInlineMap[type]) {
    insertInlineMap[type](editor, type);
  }
}

export function setBlockType(
  editor: PlateEditor,
  type: string,
  { at }: { at?: Path } = {}
) {
  if (type === KEYS.codeBlock) {
    toggleCodeBlock(editor);
    return;
  }
  if (type === KEYS.ulClassic || type === KEYS.olClassic || type === KEYS.taskList) {
    toggleClassicList(editor, type);
    return;
  }
  if (type === ACTION_THREE_COLUMNS) {
    toggleColumnGroup(editor, { columns: 3 });
    return;
  }
  setTextBlock(editor, type, at);
}

export function getBlockType(block: TElement) {
  return block.type;
}
