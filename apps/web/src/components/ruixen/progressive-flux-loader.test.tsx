import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ProgressiveFluxLoader } from "./progressive-flux-loader"

vi.mock("motion/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => true,
}))

describe("Ruixen 受控进度适配", () => {
  it("依据真实 value 选择阶段，支持 ARIA", () => {
    const markup = renderToStaticMarkup(<ProgressiveFluxLoader value={42} phases={[{ at: 0, label: "上传" }, { at: 30, label: "解析" }]} />)
    expect(markup).toContain('role="progressbar"')
    expect(markup).toContain('aria-valuenow="42"')
    expect(markup).toContain('aria-valuetext="解析 · 42%"')
  })
  it("未提供 value 不模拟百分比", () => {
    const markup = renderToStaticMarkup(<ProgressiveFluxLoader label="等待后台转换" />)
    expect(markup).toContain('data-state="indeterminate"')
    expect(markup).not.toContain("aria-valuenow")
    expect(markup).not.toContain("0% –")
  })
  it("reduced-motion 不渲染无限光泽动画", () => {
    const markup = renderToStaticMarkup(<ProgressiveFluxLoader value={42} />)
    expect(markup).not.toContain("pointer-events-none")
    expect(markup).not.toContain("opacity:0")
  })
  it("终态静止且夹紧越界值", () => {
    const markup = renderToStaticMarkup(<ProgressiveFluxLoader value={120} active={false} label="已完成" showLabel={false} />)
    expect(markup).toContain('aria-valuenow="100"')
    expect(markup).toContain('data-state="stopped"')
    expect(markup).toContain('aria-busy="false"')
    expect(markup).not.toContain("pointer-events-none")
  })
})
