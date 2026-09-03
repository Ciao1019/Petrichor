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

import { publicArticleShareApi, publicProjectShowcaseApi, publicSearchApi } from "./api"

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

    expect(first.data.items[0]?.title).toBe("公开文章")
    expect(second.data.items[0]?.shareCode).toBe("shareCode123")
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

    expect(cached.data.items[0]?.tags).toEqual(["旧标签"])
    expect(refreshed.data.items[0]?.tags).toEqual(["新标签"])
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

  it("并发列表请求复用同一个在途 Promise，强制刷新会绕过缓存", async () => {
    let resolveRequest!: (value: { data: { items: [] } }) => void
    const pending = new Promise<{ data: { items: [] } }>((resolve) => {
      resolveRequest = resolve
    })
    axiosMocks.instance.get.mockReturnValueOnce(pending)

    const first = publicArticleShareApi.list()
    const second = publicArticleShareApi.list()
    resolveRequest({ data: { items: [] } })

    await expect(first).resolves.toMatchObject({ data: { items: [] } })
    await expect(second).resolves.toMatchObject({ data: { items: [] } })
    expect(axiosMocks.instance.get).toHaveBeenCalledTimes(1)
    expect(publicArticleShareApi.getCachedList()).toEqual({ items: [] })

    axiosMocks.instance.get.mockResolvedValueOnce({ data: { items: [] } })
    await publicArticleShareApi.list({ forceRefresh: true })
    expect(axiosMocks.instance.get).toHaveBeenCalledTimes(2)
  })

  it("详情缓存读取、空分享码预取和搜索参数保持稳定", async () => {
    axiosMocks.instance.get.mockResolvedValueOnce({
      data: {
        contentMd: "正文",
        createdAt: "2026-04-28T00:00:00.000Z",
        tags: [],
        title: "公开文章",
        updatedAt: "2026-04-28T01:00:00.000Z",
      },
    })

    await publicArticleShareApi.detail(" shareCode123 ")
    expect(publicArticleShareApi.getCachedDetail("shareCode123")?.title).toBe("公开文章")
    await expect(publicArticleShareApi.prefetchDetail("  ")).resolves.toBeUndefined()

    const signal = new AbortController().signal
    axiosMocks.instance.get.mockResolvedValueOnce({ data: { items: [] } })
    await publicArticleShareApi.search({ keyword: "缓存", limit: 8, offset: 2, signal })
    expect(axiosMocks.instance.get).toHaveBeenLastCalledWith("/public/article/search", {
      params: { q: "缓存", limit: 8, offset: 2 },
      signal,
    })
  })

  it("统一公开搜索透传模式、类型、知识库和标签筛选", async () => {
    const signal = new AbortController().signal
    axiosMocks.instance.get.mockResolvedValueOnce({ data: { items: [] } })

    await publicSearchApi.search({
      q: "RAG",
      mode: "hybrid",
      type: "wiki",
      kb: "42",
      tag: "检索",
      limit: 20,
      offset: 40,
      signal,
    })

    expect(axiosMocks.instance.get).toHaveBeenLastCalledWith("/public/search", {
      params: {
        q: "RAG",
        mode: "hybrid",
        type: "wiki",
        kb: "42",
        tag: "检索",
        limit: 20,
        offset: 40,
      },
      signal,
    })
  })

  it("项目展示详情复用缓存并支持主动失效", async () => {
    const firstPayload = { heading: "项目", intro: "第一版", items: [] }
    const secondPayload = { heading: "项目", intro: "第二版", items: [] }
    axiosMocks.instance.get
      .mockResolvedValueOnce({ data: firstPayload })
      .mockResolvedValueOnce({ data: secondPayload })

    const first = await publicProjectShowcaseApi.detail()
    const cached = await publicProjectShowcaseApi.detail()
    expect(first.data).toEqual(firstPayload)
    expect(cached.data).toEqual(firstPayload)
    expect(publicProjectShowcaseApi.getCachedDetail()).toEqual(firstPayload)

    publicProjectShowcaseApi.invalidateClientCache()
    const refreshed = await publicProjectShowcaseApi.detail()
    expect(refreshed.data).toEqual(secondPayload)
    expect(axiosMocks.instance.get).toHaveBeenCalledTimes(2)
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
