import * as React from 'react';

import { toast } from 'sonner';

import {
  describeUploadError,
  describeUploadFile,
  getUploadErrorMessage,
  uploadFileToObjectStorage,
  type UploadedFile,
} from '@/lib/object-storage-upload';

export type { UploadedFile } from '@/lib/object-storage-upload';

interface UseUploadFileProps {
  onUploadComplete?: (file: UploadedFile) => void;
  onUploadError?: (error: unknown) => void;
}

/**
 * 上传流程（S3 预签名直传，防盗链方案）：
 * 1. 调用后端 /api/upload/presign-put → 获取预签名 PUT URL + objectKey
 * 2. 前端直接 PUT 文件到 S3（不主动发送 Content-Type）
 *    缤纷云 S4 会自动从文件内容/扩展名检测真实 MIME
 * 3. 返回 { url: 's4key:{objectKey}' } 存入 Plate 编辑器节点
 * 4. 渲染时由 useSignedUrl hook 实时获取有时效的下载链接（防盗链）
 */
export function useUploadFile({
  onUploadComplete,
  onUploadError,
}: UseUploadFileProps = {}) {
  const [uploadedFile, setUploadedFile] = React.useState<UploadedFile>();
  const [uploadingFile, setUploadingFile] = React.useState<File>();
  const [progress, setProgress] = React.useState<number>(0);
  const [isUploading, setIsUploading] = React.useState(false);

  async function uploadFile(file: File) {
    setIsUploading(true);
    setUploadingFile(file);
    setUploadedFile(undefined);
    setProgress(0);

    try {
      const result = await uploadFileToObjectStorage(file, { onProgress: setProgress });
      setUploadedFile(result);
      onUploadComplete?.(result);
      return result;
    } catch (error) {
      console.error('[S4 upload]', '上传流程失败', {
        error: describeUploadError(error),
        file: describeUploadFile(file),
      });
      const message = getUploadErrorMessage(error);
      toast.error(message || '上传失败，请稍后重试');
      onUploadError?.(error);
      throw error;
    } finally {
      setProgress(0);
      setIsUploading(false);
      setUploadingFile(undefined);
    }
  }

  return {
    isUploading,
    progress,
    uploadedFile,
    uploadFile,
    uploadingFile,
  };
}

export function getErrorMessage(err: unknown): string {
  return getUploadErrorMessage(err);
}

export function showErrorToast(err: unknown) {
  return toast.error(getErrorMessage(err));
}
