// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { StepBudgetNotice } from "./step-budget-notice"

describe("StepBudgetNotice", () => {
  it("只在运行中显示 warning，并在 resolved 后立即隐藏", () => {
    const { rerender } = render(
      <StepBudgetNotice data={{ status: "warning", remaining: 2 }} />,
    )
    expect(screen.getByRole("status").textContent).toContain("当前任务仍在继续")

    rerender(<StepBudgetNotice data={{ status: "warning", remaining: 2, label: "自定义运行提示" }} />)
    expect(screen.getByRole("status").textContent).toContain("自定义运行提示")

    rerender(<StepBudgetNotice data={{ status: "resolved", remaining: 2 }} />)
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("真实耗尽时保留不误导的继续提示", () => {
    render(<StepBudgetNotice data={{ status: "exhausted", remaining: 0 }} />)
    expect(screen.getByRole("status").textContent).toContain("如答案不完整")
  })

  it("忽略空数据和无效状态", () => {
    const { container, rerender } = render(<StepBudgetNotice data={null} />)
    expect(container.textContent).toBe("")
    rerender(<StepBudgetNotice data={{ status: "unknown" }} />)
    expect(container.textContent).toBe("")
  })
})
