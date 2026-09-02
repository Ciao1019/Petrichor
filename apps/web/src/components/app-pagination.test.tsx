/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AppPagination } from "./app-pagination"

afterEach(cleanup)

describe("AppPagination 记录范围", () => {
  it("空列表显示 0–0，而不是 1–0", () => {
    render(
      <AppPagination
        page={0}
        totalPages={1}
        total={0}
        pageSize={10}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText("第 0–0 条，共 0 条")).toBeTruthy()
  })

  it("末页范围不超过总记录数", () => {
    render(
      <AppPagination
        page={1}
        totalPages={2}
        total={12}
        pageSize={10}
        onChange={vi.fn()}
      />,
    )

    expect(screen.getByText("第 11–12 条，共 12 条")).toBeTruthy()
  })
})
