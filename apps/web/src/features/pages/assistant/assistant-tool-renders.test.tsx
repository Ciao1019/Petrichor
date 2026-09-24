// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { StepBudgetNotice } from "./step-budget-notice"

describe("StepBudgetNotice", () => {
  it("历史消息里的 warning/resolved 不再展示剩余次数提示", () => {
    const { container, rerender } = render(
      <StepBudgetNotice data={{ status: "warning", remaining: 2, label: "本轮还可调用 2 次工具" }} />,
    )
    expect(container.textContent).toBe("")

    rerender(<StepBudgetNotice data={{ status: "resolved", remaining: 2 }} />)
    expect(container.textContent).toBe("")
  })

  it("真实耗尽时保留不误导的继续提示", () => {
    const { rerender } = render(<StepBudgetNotice data={{ status: "exhausted", remaining: 0 }} />)
    expect(screen.getByRole("status").textContent).toContain("如答案不完整")

    rerender(<StepBudgetNotice data={{ status: "exhausted", remaining: 0, label: "自定义用尽提示" }} />)
    expect(screen.getByRole("status").textContent).toContain("自定义用尽提示")
  })

  it("忽略空数据和无效状态", () => {
    const { container, rerender } = render(<StepBudgetNotice data={null} />)
    expect(container.textContent).toBe("")
    rerender(<StepBudgetNotice data={{ status: "unknown" }} />)
    expect(container.textContent).toBe("")
  })
})
