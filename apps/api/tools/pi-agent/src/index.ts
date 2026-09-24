import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Message } from "@earendil-works/pi-ai";
import { assistant, fromWire, hostModel, toWire, type Reply, type Start } from "./protocol";

const pending = new Map<string, { resolve: (reply: Reply) => void; reject: (error: Error) => void; delta?: (text: string) => void }>();
let nextID = 0;
let agent: Agent | undefined;
let started = false;
let closed = false;
function send(frame: object) { process.stdout.write(JSON.stringify(frame) + "\n"); }
function request(type: string, payload: object, delta?: (text: string) => void): Promise<Reply> {
  if (closed) return Promise.reject(new Error("宿主连接已关闭"));
  const id = String(++nextID);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, delta });
    send({ type, id, ...payload });
  });
}

async function run(start: Start) {
  if (start.version !== 1 || !Number.isInteger(start.maxTurns) || start.maxTurns < 1) throw new Error("无效的 Pi 运行协议");
  let turns = 0;
  let limitReached = false;
  let modelFailed = false;
  agent = new Agent({
	steeringMode: "all",
	followUpMode: "all",
    initialState: {
      model: hostModel, messages: start.messages.map(fromWire),
      tools: start.tools.map(tool => ({ ...tool, label: tool.name,
        execute: async (toolCallId, args) => {
          const reply = await request("tool", { call: { id: toolCallId, name: tool.name, arguments: JSON.stringify(args) } });
          if (reply.isError) throw new Error(reply.text || "工具执行失败");
          return { content: [{ type: "text" as const, text: reply.text ?? "" }], details: {} };
        },
      })),
    },
    // Go 的 Evidence / Trace / 确认票据有顺序语义；并行子任务由受限 task 工具管理。
    toolExecution: "sequential",
    prepareRequest: async ({ context }) => {
      if (start.contextTokens <= 0) return;
      const messages = context.messages as Message[];
      // 中文按字符保守估计；宿主负责摘要，Pi 负责替换下一轮的模型上下文。
      const wire = messages.map(toWire);
      if ([...JSON.stringify(wire)].length < start.contextTokens) return;
      const reply = await request("compact", { messages: wire });
      if (reply.isError || !reply.text) throw new Error("上下文压缩失败");
      const compacted: Message[] = [...messages.filter(m => m.role === "system"), {
        role: "user", content: reply.text, timestamp: Date.now(),
      }];
      return { context: { ...context, messages: compacted } };
    },
    streamFn: (_model, context) => {
      const stream = createAssistantMessageEventStream();
      const partial = assistant({ text: "", inputTokens: 0, outputTokens: 0 });
      partial.content = [{ type: "text", text: "" }];
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      void request("model", { messages: context.messages.map(toWire) }, delta => {
        const text = partial.content[0];
        if (text.type === "text") text.text += delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial });
      }).then(reply => {
        if (reply.isError || !reply.model) throw new Error("模型调用失败");
        const message = assistant(reply.model);
        stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      }).catch(() => {
        modelFailed = true;
        partial.stopReason = "error";
        partial.errorMessage = "模型调用失败";
        stream.push({ type: "error", reason: "error", error: partial });
      });
      return stream;
    },
    finishTurn: async ({ message }) => {
      turns++;
      if (turns >= start.maxTurns) {
        limitReached = message.content.some(part => part.type === "toolCall") || Boolean(agent?.hasQueuedMessages());
        return { action: "end" };
      }
      if (start.enableControl) {
        const reply = await request("control", {});
        for (const control of reply.controls ?? []) {
          const message = { role: "user" as const, content: control.text, timestamp: Date.now() };
          if (control.mode === "steer") agent?.steer(message);
          else if (control.mode === "follow_up") agent?.followUp(message);
          else throw new Error("未知的运行控制类型");
        }
      }
    },
  });
  await agent.continue();
  send({ type: "done", limitReached, failed: modelFailed || Boolean(agent.state.errorMessage) });
}

// 只按 LF 切 JSONL；U+2028/U+2029 可能出现在文档正文里，不能作为分隔符。
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 32 * 1024 * 1024) process.exit(2);
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    try {
      const frame: Start | Reply = JSON.parse(line);
      if (frame.type === "start") {
        if (started) throw new Error("重复启动");
        started = true;
        void run(frame).catch(() => send({ type: "done", failed: true }));
      } else {
        const waiter = pending.get(frame.id);
        if (!waiter) throw new Error("未知的响应 ID");
        if (frame.type === "delta") waiter.delta?.(frame.delta ?? "");
        else { pending.delete(frame.id); waiter.resolve(frame); }
      }
    } catch { process.exit(2); }
  }
});
process.stdin.on("end", () => {
  closed = true;
  agent?.abort();
  for (const waiter of pending.values()) waiter.reject(new Error("宿主连接已关闭"));
  pending.clear();
});
