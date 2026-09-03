import { describe, expect, it } from "vitest"

import { buildFilingLinks } from "@/components/public-site-footer"
import type { SiteFilingResponse } from "@/lib/api"

const config: SiteFilingResponse = {
  enabled: true,
  icpNumber: "京ICP备123号",
  icpUrl: "https://beian.miit.gov.cn/",
  publicSecurityNumber: "京公网安备 110000000001 号",
  publicSecurityUrl: "https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=110000000001",
}

describe("buildFilingLinks", () => {
  it("仅在启用时生成备案链接", () => {
    expect(buildFilingLinks({ ...config, enabled: false })).toEqual([])
    expect(buildFilingLinks(config)).toHaveLength(2)
  })

  it("过滤空备案号与非 HTTP(S) 地址", () => {
    expect(buildFilingLinks({
      ...config,
      icpNumber: "",
      publicSecurityUrl: "javascript:alert(1)",
    })).toEqual([])
  })
})
