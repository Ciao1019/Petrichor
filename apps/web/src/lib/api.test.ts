import { beforeEach, describe, expect, it, vi } from "vitest"

const axiosMocks = vi.hoisted(() => {
  let responseErrorInterceptor: ((error: unknown) => unknown) | undefined
  const instance = {
    get: vi.fn(),
    post: vi.fn(),
    interceptors: {
      response: {
        use: vi.fn((_onFulfilled: unknown, onRejected: (error: unknown) => unknown) => {
          responseErrorInterceptor = onRejected
        }),
      },
    },
  }

  return {
    axios: {
      create: vi.fn(() => instance),
    },
    instance,
    getResponseErrorInterceptor: () => responseErrorInterceptor,
  }
})

vi.mock("axios", () => ({
  default: axiosMocks.axios,
}))

import { publicArticleShareApi } from "./api"

function mockWindowLocation(pathname: string, search = "", hash = "") {
  const replace = vi.fn()
  vi.stubGlobal("window", {
    location: {
      hash,
      pathname,
      replace,
      search,
    },
  })
  return replace
}

function getResponseErrorInterceptor() {
  const interceptor = axiosMocks.getResponseErrorInterceptor()
  if (!interceptor) {
    throw new Error("Axios 响应错误拦截器未注册")
  }
  return interceptor
}

describe("publicArticleShareApi client cache", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    publicArticleShareApi.resetClientCacheForTests()
  })

  it("公开文章列表使用 GET 并复用内存缓存", async () => {
    axiosMocks.instance.get.mockResolvedValueOnce({
      data: {
        items: [{
          articleId: "9",
          expired: false,
          excerpt: "摘要",
          hasPassword: false,
          href: "/p/shareCode123",
          isRepost: false,
          readingMinutes: 1,
          shareCode: "shareCode123",
          tags: [],
          title: "公开文章",
          updatedAt: "2026-04-28T00:00:00.000Z",
        }],
      },
    })

    const first = await publicArticleShareApi.list()
    const second = await publicArticleShareApi.list()

    expect(first.data.items[0].title).toBe("公开文章")
    expect(second.data.items[0].shareCode).toBe("shareCode123")
    expect(axiosMocks.instance.get).toHaveBeenCalledTimes(1)
    expect(axiosMocks.instance.get).toHaveBeenCalledWith("/public/article/list")
    expect(axiosMocks.instance.post).not.toHaveBeenCalled()
  })

  it("公开文章客户端缓存可在文章保存后主动失效", async () => {
    axiosMocks.instance.get
      .mockResolvedValueOnce({
        data: {
          items: [{
            articleId: "9",
            expired: false,
            excerpt: "旧摘要",
            hasPassword: false,
            href: "/p/shareCode123",
            isRepost: false,
            readingMinutes: 1,
            shareCode: "shareCode123",
            tags: ["旧标签"],
            title: "旧公开文章",
            updatedAt: "2026-04-28T00:00:00.000Z",
          }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [{
            articleId: "9",
            expired: false,
            excerpt: "新摘要",
            hasPassword: false,
            href: "/p/shareCode123",
            isRepost: true,
            readingMinutes: 1,
            shareCode: "shareCode123",
            tags: ["新标签"],
            title: "新公开文章",
            updatedAt: "2026-04-29T00:00:00.000Z",
          }],
        },
      })

    const cached = await publicArticleShareApi.list()
    publicArticleShareApi.invalidateClientCache()
    const refreshed = await publicArticleShareApi.list()

    expect(cached.data.items[0].tags).toEqual(["旧标签"])
    expect(refreshed.data.items[0].tags).toEqual(["新标签"])
    expect(axiosMocks.instance.get).toHaveBeenCalledTimes(2)
    expect(axiosMocks.instance.get).toHaveBeenNthCalledWith(1, "/public/article/list")
    expect(axiosMocks.instance.get).toHaveBeenNthCalledWith(2, "/public/article/list")
  })

  it("无密码公开详情使用 GET 缓存，带密码详情保留 POST", async () => {
    axiosMocks.instance.get.mockResolvedValueOnce({
      data: {
        contentMd: "正文",
        createdAt: "2026-04-28T00:00:00.000Z",
        tags: [],
        title: "公开文章",
        updatedAt: "2026-04-28T01:00:00.000Z",
      },
    })
    axiosMocks.instance.post.mockResolvedValueOnce({
      data: {
        contentMd: "密码正文",
        createdAt: "2026-04-28T00:00:00.000Z",
        tags: [],
        title: "密码文章",
        updatedAt: "2026-04-28T01:00:00.000Z",
      },
    })

    const publicDetail = await publicArticleShareApi.detail("shareCode123")
    await publicArticleShareApi.prefetchDetail("shareCode123")
    const cachedDetail = await publicArticleShareApi.detail("shareCode123")
    const passwordDetail = await publicArticleShareApi.detail("shareCode123", " 123456 ")

    expect(publicDetail.data.title).toBe("公开文章")
    expect(cachedDetail.data.contentMd).toBe("正文")
    expect(passwordDetail.data.title).toBe("密码文章")
    expect(axiosMocks.instance.get).toHaveBeenCalledTimes(1)
    expect(axiosMocks.instance.get).toHaveBeenCalledWith("/public/article/share/detail", {
      params: { shareCode: "shareCode123" },
    })
    expect(axiosMocks.instance.post).toHaveBeenCalledWith("/public/article/share/detail", {
      accessPassword: "123456",
      shareCode: "shareCode123",
    })
  })

  it("前台公开文章页遇到 401 不自动跳后台登录", async () => {
    const replace = mockWindowLocation("/p/shareCode123")
    const interceptor = getResponseErrorInterceptor()
    const error = {
      config: { url: "/public/article/share/detail" },
      response: { status: 401, data: { code: 401, msg: "该链接需要访问密码" } },
    }

    await expect(interceptor(error)).rejects.toBe(error)

    expect(replace).not.toHaveBeenCalled()
  })

  it("后台页面遇到 401 仍自动跳登录并保留回跳地址", async () => {
    const replace = mockWindowLocation("/dashboard/knowledge", "?page=1", "#node-2")
    const interceptor = getResponseErrorInterceptor()
    const error = {
      config: { url: "/kb/knowledge-base/list" },
      response: { status: 401, data: { code: 401, msg: "请先登录" } },
    }

    await expect(interceptor(error)).rejects.toBe(error)

    expect(replace).toHaveBeenCalledWith("/login?redirect=%2Fdashboard%2Fknowledge%3Fpage%3D1%23node-2")
  })
})
