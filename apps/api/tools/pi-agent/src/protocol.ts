import type { AssistantMessage, Message, Model, Tool, Usage } from "@earendil-works/pi-ai";

export interface Call { id: string; name: string; arguments: string }
export interface WireMessage {
  role: string;
  content: string;
  toolCalls?: Call[];
  toolCallId?: string;
  toolName?: string;
}
export interface Start {
  type: "start";
  version: 1;
  messages: WireMessage[];
  tools: Tool[];
  maxTurns: number;
  contextTokens: number;
  enableControl?: boolean;
}
export interface ModelResult {
  text: string;
  toolCalls?: Call[];
  inputTokens: number;
  outputTokens: number;
}
export interface Reply {
  type: "result" | "delta";
  id: string;
  delta?: string;
  model?: ModelResult;
  text?: string;
  isError?: boolean;
  controls?: { sequence: number; mode: "steer" | "follow_up"; text: string }[];
}

// 模型和凭据由 Go 宿主管理；这个描述符只用于 Pi 的消息、事件和工具循环。
export const hostModel: Model<"openai-completions"> = {
  id: "petrichor-host", name: "Petrichor model gateway", api: "openai-completions",
  provider: "petrichor", baseUrl: "", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 16000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export function usage(input = 0, output = 0): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function assistant(result: ModelResult): AssistantMessage {
  const content: AssistantMessage["content"] = result.text ? [{ type: "text", text: result.text }] : [];
  for (const call of result.toolCalls ?? []) {
    // 非法 JSON 不得替换为 {}，必须让本轮失败，禁止执行被悄悄改写的参数。
    const args: unknown = JSON.parse(call.arguments || "{}");
    if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是 JSON 对象");
    content.push({ type: "toolCall", id: call.id, name: call.name,
      arguments: args as Record<string, import("@earendil-works/pi-ai").JsonValue> });
  }
  return { role: "assistant", content, api: hostModel.api, provider: hostModel.provider,
    model: hostModel.id, usage: usage(result.inputTokens, result.outputTokens),
    stopReason: result.toolCalls?.length ? "toolUse" : "stop", timestamp: Date.now() };
}

export function fromWire(message: WireMessage): Message {
  const timestamp = Date.now();
  if (message.role === "assistant") return assistant({ text: message.content,
    toolCalls: message.toolCalls, inputTokens: 0, outputTokens: 0 });
  if (message.role === "tool") return { role: "toolResult", toolCallId: message.toolCallId ?? "",
    toolName: message.toolName ?? "", content: [{ type: "text", text: message.content }], isError: false, timestamp };
  if (message.role !== "user" && message.role !== "system") throw new Error("不支持的消息角色");
  return { role: message.role, content: message.content, timestamp };
}

export function toWire(message: Message): WireMessage {
  const content = typeof message.content === "string" ? message.content :
    message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
  if (message.role === "toolResult") return { role: "tool", content,
    toolCallId: message.toolCallId, toolName: message.toolName };
  if (message.role === "assistant") return { role: "assistant", content,
    toolCalls: message.content.flatMap(part => part.type === "toolCall" ? [{
      id: part.id, name: part.name, arguments: JSON.stringify(part.arguments),
    }] : []) };
  return { role: message.role, content };
}
