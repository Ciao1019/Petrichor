import * as React from 'react';

import { uploadApi } from '@/lib/api';
import { normalizeS4ObjectKey, normalizeS4ObjectUrl } from '@/lib/s4-url';

type SignedUrlPublicAccessValue = {
  publicAccess: boolean;
  mediaAccessToken?: string | null;
};

const SignedUrlPublicAccessContext = React.createContext<SignedUrlPublicAccessValue>({
  publicAccess: false,
  mediaAccessToken: null,
});

// 简单内存缓存，避免同一 key 重复请求
const cache = new Map<string, { url: string; expiresAt: number }>();
// 缓存有效期：比后端 download-expire-seconds（3600s）少 5 分钟
const CACHE_TTL_MS = 55 * 60 * 1000;

type SignedUrlPublicAccessProviderProps = {
  children: React.ReactNode;
  publicAccess?: boolean;
  mediaAccessToken?: string | null;
};

export function resolveSignedUrlPublicAccess(
  explicitPublicAccess: boolean | undefined,
  inheritedPublicAccess: boolean
): boolean {
  return explicitPublicAccess ?? inheritedPublicAccess;
}

export function SignedUrlPublicAccessProvider({
  children,
  publicAccess = false,
  mediaAccessToken = null,
}: SignedUrlPublicAccessProviderProps) {
  const value = React.useMemo(
    () => ({ publicAccess, mediaAccessToken }),
    [mediaAccessToken, publicAccess]
  );
  return React.createElement(
    SignedUrlPublicAccessContext.Provider,
    { value },
    children
  );
}

function signedUrlCacheKey(objectKey: string, isPublic: boolean, mediaAccessToken?: string | null) {
  return `${isPublic ? `public:${mediaAccessToken || "anonymous"}` : "private"}:${objectKey}`;
}

async function fetchSignedUrl(
  objectKey: string,
  isPublic: boolean,
  mediaAccessToken?: string | null
): Promise<string> {
  const cacheKey = signedUrlCacheKey(objectKey, isPublic, mediaAccessToken);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  const { data } = isPublic
    ? await uploadApi.publicPresignGet(objectKey, mediaAccessToken)
    : await uploadApi.presignGet(objectKey);

  cache.set(cacheKey, { url: data.url, expiresAt: Date.now() + CACHE_TTL_MS });
  return data.url;
}

/**
 * useSignedUrl — 将 s4key:{objectKey} 转换为具有时效的预签名下载 URL（防盗链）。
 *
 * - 普通 URL（非 S4 对象地址）直接返回原值
 * - isPublic=true 时使用无需鉴权的公开接口（供分享页使用）
 */
export function useSignedUrl(url: string | undefined | null, isPublic?: boolean): string | undefined {
  const inheritedPublicAccess = React.useContext(SignedUrlPublicAccessContext);
  const shouldUsePublicAccess = resolveSignedUrlPublicAccess(isPublic, inheritedPublicAccess.publicAccess);
  const mediaAccessToken = shouldUsePublicAccess ? inheritedPublicAccess.mediaAccessToken : null;

  const [signedUrl, setSignedUrl] = React.useState<string | undefined>(() => {
    // 非 S4 对象地址直接用原 URL
    const objectKey = normalizeS4ObjectKey(url);
    if (!objectKey) return url ?? undefined;
    // 检查缓存
    const cached = cache.get(signedUrlCacheKey(objectKey, shouldUsePublicAccess, mediaAccessToken));
    if (cached && cached.expiresAt > Date.now()) return cached.url;
    return undefined;
  });

  React.useEffect(() => {
    if (!url) {
      setSignedUrl(undefined);
      return;
    }
    const objectKey = normalizeS4ObjectKey(url);
    if (!objectKey) {
      setSignedUrl(url);
      return;
    }

    let cancelled = false;

    fetchSignedUrl(objectKey, shouldUsePublicAccess, mediaAccessToken)
      .then((signed) => {
        if (!cancelled) setSignedUrl(signed);
      })
      .catch(() => {
        // 获取签名失败不崩溃，静默处理
      });

    return () => {
      cancelled = true;
    };
  }, [mediaAccessToken, shouldUsePublicAccess, url]);

  return signedUrl;
}

/** 判断 URL 是否是 S4 对象 key */
export function isS4Key(url: string | undefined | null): boolean {
  return normalizeS4ObjectKey(url) != null;
}

/** 从 s4key:{objectKey} 中提取 objectKey */
export function extractObjectKey(url: string): string {
  return normalizeS4ObjectKey(url) ?? url;
}

/** 将 uploads/... 这类对象 key 规范化为 s4key:uploads/... */
export function toS4Url(url: string | undefined | null): string | null {
  return normalizeS4ObjectUrl(url);
}
