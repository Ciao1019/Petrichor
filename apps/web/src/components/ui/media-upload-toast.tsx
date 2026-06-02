'use client';

import * as React from 'react';

import { PlaceholderPlugin, UploadErrorCode } from '@platejs/media/react';
import { usePluginOption } from 'platejs/react';
import { toast } from 'sonner';

export function MediaUploadToast() {
  useUploadErrorToast();

  return null;
}

const useUploadErrorToast = () => {
  const uploadError = usePluginOption(PlaceholderPlugin, 'error');

  React.useEffect(() => {
    if (!uploadError) return;

    const { code, data } = uploadError;

    switch (code) {
      case UploadErrorCode.INVALID_FILE_SIZE: {
        toast.error(`文件大小配置无效：${formatFileNames(data.files)}`);

        break;
      }
      case UploadErrorCode.INVALID_FILE_TYPE: {
        toast.error(`文件类型不支持：${formatFileNames(data.files)}`);

        break;
      }
      case UploadErrorCode.TOO_LARGE: {
        toast.error(
          `文件过大：${formatFileNames(data.files)} 超过 ${data.maxFileSize} 上限`
        );

        break;
      }
      case UploadErrorCode.TOO_LESS_FILES: {
        toast.error(
          `至少需要选择 ${data.minFileCount} 个${formatFileType(data.fileType)}`
        );

        break;
      }
      case UploadErrorCode.TOO_MANY_FILES: {
        toast.error(
          `最多只能选择 ${data.maxFileCount} 个${formatFileType(data.fileType)}`
        );

        break;
      }
    }
  }, [uploadError]);
};

function formatFileNames(files: File[]) {
  return files.map((file) => file.name).join('、') || '所选文件';
}

function formatFileType(fileType?: string | null) {
  if (!fileType) return '文件';

  const label: Record<string, string> = {
    audio: '音频文件',
    blob: '文件',
    image: '图片',
    pdf: 'PDF 文件',
    text: '文本文件',
    video: '视频',
  };

  return label[fileType] ?? '文件';
}
