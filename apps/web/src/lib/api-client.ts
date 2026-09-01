import axios from "axios"

import { installDemoAdapter } from "@/lib/demo/demo-adapter"

export const api = axios.create({
  baseURL: "/api",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
})

// 演示模式（/demo）下把所有请求拦到内存 mock，非演示模式零开销直通网络。
installDemoAdapter(api)

export interface ApiErrorResponse {
  code: number
  msg: string
  path?: string
  timestamp?: string
}

function isAuthEndpoint(url: string) {
  return url.includes("/auth/login")
    || url.includes("/auth/register")
    || url.includes("/auth/setup")
    || url.includes("/auth/linuxdo/callback")
}

function shouldRedirectToLoginOnUnauthorized(pathname: string) {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/")
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status: number | undefined = error?.response?.status
    const data: ApiErrorResponse | undefined = error?.response?.data
    const code = data?.code

    const url: string = error?.config?.url || ""
    const browserLocation = typeof window === "undefined" ? null : window.location
    const shouldRedirectToLogin =
      browserLocation !== null &&
      !isAuthEndpoint(url) &&
      (status === 401 || code === 401) &&
      shouldRedirectToLoginOnUnauthorized(browserLocation.pathname)

    if (shouldRedirectToLogin && browserLocation) {
      const currentPath = browserLocation.pathname + browserLocation.search + browserLocation.hash
      const redirect = encodeURIComponent(currentPath)
      browserLocation.replace(`/login?redirect=${redirect}`)
    }

    return Promise.reject(error)
  },
)
