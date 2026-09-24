/** 前台问答限流主键：FingerprintJS 浏览器指纹，随请求头发给服务端。 */
export const FINGERPRINT_HEADER = "X-Petrichor-Fingerprint"

let pending: Promise<string> | null = null

/**
 * 懒加载 FingerprintJS 并缓存 visitorId。关闭 monitoring，避免向第三方统计域名发请求。
 * 失败（脚本被拦截、环境不支持）时返回空串，由服务端按 IP 限流；下次调用重新尝试。
 */
export function getVisitorFingerprint(): Promise<string> {
  pending ??= import("@fingerprintjs/fingerprintjs")
    .then(({ load }) => load({ monitoring: false }))
    .then((agent) => agent.get())
    .then((result) => result.visitorId)
    .catch(() => {
      pending = null
      return ""
    })
  return pending
}
