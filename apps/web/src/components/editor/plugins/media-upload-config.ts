import type { UploadConfig } from '@platejs/media/react';
import { KEYS } from 'platejs';

export const EDITOR_VIDEO_UPLOAD_MAX_SIZE = '512MB' as const;

export const EDITOR_MEDIA_UPLOAD_CONFIG = {
  audio: {
    maxFileCount: 1,
    maxFileSize: '8MB',
    mediaType: KEYS.audio,
    minFileCount: 1,
  },
  blob: {
    maxFileCount: 1,
    maxFileSize: '8MB',
    mediaType: KEYS.file,
    minFileCount: 1,
  },
  image: {
    maxFileCount: 3,
    maxFileSize: '4MB',
    mediaType: KEYS.img,
    minFileCount: 1,
  },
  pdf: {
    maxFileCount: 1,
    maxFileSize: '4MB',
    mediaType: KEYS.file,
    minFileCount: 1,
  },
  text: {
    maxFileCount: 1,
    maxFileSize: '64KB',
    mediaType: KEYS.file,
    minFileCount: 1,
  },
  video: {
    maxFileCount: 1,
    maxFileSize: EDITOR_VIDEO_UPLOAD_MAX_SIZE,
    mediaType: KEYS.video,
    minFileCount: 1,
  },
} satisfies UploadConfig;
