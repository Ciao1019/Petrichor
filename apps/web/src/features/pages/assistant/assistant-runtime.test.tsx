// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import * as React from "react"
import { afterEach, describe, expect, it } from "vitest"

import type { AssistantUIMessage } from "./assistant-message-utils"

const EMPTY_MESSAGES: AssistantUIMessage[] = []

function AssistantRuntimeHarness() {
  const transport = React.useMemo(
    () => new AssistantChatTransport({ api: "/api/assistant/chat" }),
    [],
  )
  const runtime = useChatRuntime({
    id: "assistant-runtime-test",
    messages: EMPTY_MESSAGES,
    transport,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ComposerPrimitive.Root>
          <ComposerPrimitive.Input aria-label="消息" />
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

afterEach(cleanup)

describe("智能助手运行时", () => {
  it("挂载后保持稳定，并允许更新输入内容", () => {
    render(<AssistantRuntimeHarness />)

    const input = screen.getByRole("textbox", { name: "消息" })
    fireEvent.change(input, { target: { value: "测试输入" } })

    expect((input as HTMLTextAreaElement).value).toBe("测试输入")
  })
})
