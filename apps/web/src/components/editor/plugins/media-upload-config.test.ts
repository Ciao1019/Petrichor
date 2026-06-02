import {
  type UploadError,
  UploadErrorCode,
  isUploadError,
  validateFiles,
} from '@platejs/media/react';
import { describe, expect, it } from 'vitest';

import {
  EDITOR_MEDIA_UPLOAD_CONFIG,
  EDITOR_VIDEO_UPLOAD_MAX_SIZE,
} from './media-upload-config';

describe('editor media upload config', () => {
  it('允许上传超过 Plate 默认 16MB 但未超过项目上限的视频', () => {
    expect(() =>
      validateFiles(
        [
          createFile('demo.mp4', 17 * 1024 * 1024, 'video/mp4'),
        ] as unknown as FileList,
        EDITOR_MEDIA_UPLOAD_CONFIG
      )
    ).not.toThrow();
  });

  it('视频超过项目上限时仍然拦截', () => {
    let error: unknown;

    try {
      validateFiles(
        [
          createFile('huge.mp4', 513 * 1024 * 1024, 'video/mp4'),
        ] as unknown as FileList,
        EDITOR_MEDIA_UPLOAD_CONFIG
      );
    } catch (caught) {
      error = caught;
    }

    expect(isUploadError(error)).toBe(true);
    if (!isUploadError(error)) return;

    expect(error.code).toBe(UploadErrorCode.TOO_LARGE);
    const tooLargeError = error as Extract<
      UploadError,
      { code: typeof UploadErrorCode.TOO_LARGE }
    >;
    expect(tooLargeError.data.maxFileSize).toBe(EDITOR_VIDEO_UPLOAD_MAX_SIZE);
  });
});

function createFile(name: string, size: number, type: string): File {
  return {
    name,
    size,
    type,
  } as File;
}
