'use client';

import { z } from 'zod';

import { uploadApi } from '@/lib/api';
import { completeDemoUpload } from '@/lib/demo/demo-adapter';

export interface UploadedFile {
  key: string;
  url: string;    // s4key:{objectKey} — 存入编辑器节点
  name: string;
  size: number;
  type: string;
}

export interface UploadFileToObjectStorageOptions {
  onProgress?: (value: number) => void;
  signal?: AbortSignal;
  /** PUT 最长等待时间；预签名最多等待 30 秒。 */
  timeoutMs?: number;
}

export async function uploadFileToObjectStorage(
  file: File,
  options: UploadFileToObjectStorageOptions = {}
): Promise<UploadedFile> {
  const setProgress = options.onProgress ?? (() => {});
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? Math.max(1, Math.min(options.timeoutMs!, 2_147_483_647)) : 300_000;
  options.signal?.throwIfAborted();

  uploadLog('info', '开始获取服务端上传地址', {
    file: describeUploadFile(file),
  });
  const { data: presignData } = await uploadApi.presignPut({ filename: file.name }, {
    signal: options.signal,
    timeout: Math.min(timeoutMs, 30_000),
  });
  options.signal?.throwIfAborted();
  uploadLog('info', '获取服务端上传地址成功', {
    objectKey: presignData.objectKey,
    target: describePresignedUrl(presignData.presignedUrl),
  });

  if (!completeDemoUpload(presignData.presignedUrl, presignData.objectKey, options.signal, setProgress)) {
    await uploadToPresignedUrl(presignData.presignedUrl, file, setProgress, {
      objectKey: presignData.objectKey,
    }, options.signal, timeoutMs);
  }

  const result: UploadedFile = {
    key: presignData.objectKey,
    url: `s4key:${presignData.objectKey}`,
    name: file.name,
    size: file.size,
    type: file.type,
  };

  uploadLog('info', '上传流程完成', {
    file: describeUploadFile(file),
    objectKey: result.key,
  });

  return result;
}

export function getUploadErrorMessage(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues.map((i) => i.message).join('\n');
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong, please try again later.';
}

export function describeUploadFile(file: File) {
  return {
    lastModified: file.lastModified,
    name: file.name,
    size: file.size,
    type: file.type || '(empty)',
  };
}

export function describeUploadError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return error;
}

async function uploadToPresignedUrl(
  presignedUrl: string,
  file: File,
  setProgress: (value: number) => void,
  context: {
    objectKey: string;
  },
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  signal?.throwIfAborted();
  const target = describePresignedUrl(presignedUrl);
  const startedAt = Date.now();
  // 使用 Blob 上传到同源 Go 接口，避免大文件额外复制为 ArrayBuffer。
  const uploadBody = file.slice(0, file.size, '');

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let lastLoggedProgress = 0;
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      xhr.upload.onprogress = null;
      xhr.onload = xhr.onerror = xhr.onabort = xhr.ontimeout = null;
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => {
      xhr.abort();
      // 部分实现对尚未 send 的请求不触发 onabort。
      finish(signal?.reason ?? new DOMException('上传已中止', 'AbortError'));
    };

    try {
      xhr.open('PUT', presignedUrl, true);
      xhr.timeout = timeoutMs;
      uploadLog('info', '开始上传到 Go 服务端', {
        byteLength: file.size,
        file: describeUploadFile(file),
        objectKey: context.objectKey,
        target,
      });
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const nextProgress = Math.min(Math.round((e.loaded / e.total) * 100), 99);
          setProgress(nextProgress);
          if (nextProgress >= lastLoggedProgress + 25 || nextProgress === 99) {
            lastLoggedProgress = nextProgress;
            uploadLog('debug', 'PUT 上传进度', {
              loaded: e.loaded, objectKey: context.objectKey, progress: nextProgress, total: e.total,
            });
          }
        }
      };
      xhr.onload = () => {
        uploadLog(xhr.status >= 200 && xhr.status < 300 ? 'info' : 'error', 'PUT 请求完成', {
          elapsedMs: Date.now() - startedAt,
          objectKey: context.objectKey,
          readyState: xhr.readyState,
          responseText: summarizeResponseText(xhr.responseText),
          status: xhr.status,
          statusText: xhr.statusText,
          target,
        });
        if (xhr.status >= 200 && xhr.status < 300) {
          finish();
          setProgress(100);
        } else finish(buildUploadError(xhr));
      };
      const fail = (message: string, error: Error, event: ProgressEvent<EventTarget>) => {
        logXhrFailure(message, xhr, event, {
          elapsedMs: Date.now() - startedAt, objectKey: context.objectKey, target,
        });
        finish(error);
      };
      xhr.onerror = (event) => fail('PUT 网络错误', new Error('网络错误，上传失败'), event);
      xhr.onabort = (event) => fail('PUT 请求被中止', new DOMException('上传已中止', 'AbortError'), event);
      xhr.ontimeout = (event) => fail('PUT 请求超时', new Error('上传超时，请稍后重试'), event);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else xhr.send(uploadBody);
    } catch (error) {
      finish(error);
    }
  });
}

function buildUploadError(xhr: XMLHttpRequest): Error {
  try {
    const response: unknown = JSON.parse(xhr.responseText);
    if (response && typeof response === 'object' && 'msg' in response && typeof response.msg === 'string') {
      return new Error(response.msg);
    }
  } catch { /* 代理非 JSON 错误仍显示 HTTP 状态。 */ }
  const details = extractXmlErrorDetails(xhr.responseText);
  if (!details) {
    return new Error(`上传失败：HTTP ${xhr.status}`);
  }

  const message = details.message
    ? `上传失败：HTTP ${xhr.status} ${details.code} - ${details.message}`
    : `上传失败：HTTP ${xhr.status} ${details.code}`;
  return new Error(message);
}

function extractXmlErrorDetails(responseText: string) {
  const code = matchXmlTag(responseText, 'Code');
  const message = matchXmlTag(responseText, 'Message');
  if (!code) {
    return undefined;
  }
  return { code, message };
}

function matchXmlTag(source: string, tagName: string) {
  const pattern = new RegExp(`<${tagName}>([^<]+)</${tagName}>`);
  const match = source.match(pattern);
  return match?.[1]?.trim();
}

type UploadLogLevel = 'debug' | 'info' | 'warn' | 'error';

function uploadLog(level: UploadLogLevel, message: string, details?: Record<string, unknown>) {
  const prefix = '[S4 upload]';
  if (details) {
    console[level](prefix, message, details);
    return;
  }
  console[level](prefix, message);
}

function describePresignedUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl, typeof window === 'undefined' ? undefined : window.location.href);
    return {
      hasQuery: url.search.length > 0,
      origin: url.origin,
      pathname: url.pathname,
      protocol: url.protocol,
    };
  } catch (error) {
    return {
      parseError: describeUploadError(error),
    };
  }
}

function summarizeResponseText(responseText: string) {
  if (!responseText) {
    return '';
  }
  return responseText.length > 800 ? `${responseText.slice(0, 800)}...` : responseText;
}

function logXhrFailure(
  message: string,
  xhr: XMLHttpRequest,
  event: ProgressEvent<EventTarget>,
  details: {
    elapsedMs: number;
    objectKey: string;
    target: ReturnType<typeof describePresignedUrl>;
  }
) {
  uploadLog('error', message, {
    elapsedMs: details.elapsedMs,
    eventType: event.type,
    hint: '常见原因：对象存储 CORS 未允许当前站点、endpoint 不可达、证书/DNS 问题、浏览器或网络拦截。',
    objectKey: details.objectKey,
    readyState: xhr.readyState,
    responseText: summarizeResponseText(xhr.responseText),
    status: xhr.status,
    statusText: xhr.statusText,
    target: details.target,
  });
}
