// @vitest-environment jsdom
import * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { CaptureConfig } from "@/lib/api-capture"
import { CaptureInput } from "./CaptureInput"
import { defaultCaptureOptions } from "./capture-utils"

const config: CaptureConfig = { enabled: true, screenshot: true, actions: true, aiFormats: true, modelReady: true, maxBatch: 10, dailyLimit: 50, used: 0 }
afterEach(cleanup)

function Form({ settings = config, onSubmit = vi.fn() }: { settings?: CaptureConfig; onSubmit?: () => void }) {
  const [urls, setURLs] = React.useState("")
  const [options, setOptions] = React.useState(defaultCaptureOptions)
  return <CaptureInput urls={urls} options={options} config={settings} busy={false} onURLs={setURLs} onOptions={setOptions} onSubmit={onSubmit} />
}

it("无需配置模型即可收藏原文，中文输入确认和换行不会误提交", () => {
  const submit = vi.fn()
  render(<Form settings={{ ...config, modelReady: false, aiFormats: false }} onSubmit={submit} />)
  const input = screen.getByRole("textbox", { name: "网页地址，每行一个" })
  expect(screen.getByRole("button", { name: "采集网页" }).hasAttribute("disabled")).toBe(true)
  fireEvent.change(input, { target: { value: "https://example.com/article" } })
  fireEvent.keyDown(input, { key: "Enter", isComposing: true })
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
  expect(submit).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: "Enter" })
  expect(submit).toHaveBeenCalledOnce()
  expect(screen.getByRole("button", { name: "AI 整理" }).hasAttribute("disabled")).toBe(true)
})

it("AI 开关明确改变提交用途，额度耗尽后阻止提交", () => {
  const page = render(<Form />)
  fireEvent.click(screen.getByRole("button", { name: "AI 整理" }))
  expect(screen.getByRole("button", { name: "采集并整理" })).toBeTruthy()
  expect(screen.queryByText("素材收集")).toBeNull()
  page.rerender(<Form settings={{ ...config, used: 50 }} />)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://example.com" } })
  expect(screen.getByRole("button", { name: "采集并整理" }).hasAttribute("disabled")).toBe(true)
  expect(screen.getByRole("status").textContent).toContain("额度已用完")
})
