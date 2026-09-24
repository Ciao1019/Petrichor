import { describe, expect, test } from "bun:test";
import { assistant, fromWire, toWire, type WireMessage } from "./protocol";

describe("Go/Pi 消息边界", () => {
  test("历史工具调用、结果与 Unicode 分隔符完整往返", () => {
    const messages: WireMessage[] = [
      { role: "system", content: "指令" },
      { role: "user", content: "首行\n中间\u2028末尾\u2029" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "lookup", arguments: '{"q":"中文"}' }] },
      { role: "tool", content: '{"ok":true}', toolCallId: "1", toolName: "lookup" },
    ];
    expect(messages.map(message => toWire(fromWire(message)))).toEqual(messages);
  });

  test("非法参数不能静默变成空对象后执行", () => {
    for (const argumentsText of ["{", "null", "[]", '"text"']) {
      expect(() => assistant({ text: "", inputTokens: 0, outputTokens: 0,
        toolCalls: [{ id: "1", name: "write", arguments: argumentsText }] })).toThrow();
    }
  });

  test("不把推理内容传给业务消息", () => {
    const message = assistant({ text: "回答", inputTokens: 10, outputTokens: 2 });
    message.content.unshift({ type: "thinking", thinking: "内部推理" });
    expect(toWire(message).content).toBe("回答");
    expect(message.usage.totalTokens).toBe(12);
  });
});
