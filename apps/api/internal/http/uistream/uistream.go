package uistream

import (
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// Writer 写出 AI SDK UIMessageStream（v1）SSE 帧，供前端 @ai-sdk / assistant-ui 消费。
type Writer struct {
	w         gin.ResponseWriter
	flusher   httpFlusher
	messageID string
	textID    string
	textOpen  bool
	stateMu   sync.Mutex
	writeMu   sync.Mutex
}

type httpFlusher interface {
	Flush()
}

// DataOptions 控制 data-* 自定义 part 选项。
type DataOptions struct {
	ID        string
	Transient bool
}

// Start 写出 stream start；不在此处自动 text-start，以便先 emit tool/data parts。
func Start(c *gin.Context) *Writer {
	c.Header("Content-Type", "text/event-stream; charset=utf-8")
	c.Header("Cache-Control", "no-cache, no-transform")
	c.Header("Connection", "keep-alive")
	c.Header("x-vercel-ai-ui-message-stream", "v1")
	c.Status(200)
	flusher, _ := c.Writer.(httpFlusher)
	w := &Writer{
		w:         c.Writer,
		flusher:   flusher,
		messageID: "msg_" + uuid.NewString(),
		textID:    "text_" + uuid.NewString(),
	}
	w.write(map[string]any{"type": "start", "messageId": w.messageID})
	return w
}

func (w *Writer) MessageID() string { return w.messageID }

// TextStart 在首个文本 delta 前调用；可多次调用但仅首次生效。
func (w *Writer) TextStart() {
	w.stateMu.Lock()
	defer w.stateMu.Unlock()
	if w.textOpen {
		return
	}
	w.textOpen = true
	w.write(map[string]any{"type": "text-start", "id": w.textID})
}

func (w *Writer) TextDelta(delta string) {
	if delta == "" {
		return
	}
	w.TextStart()
	w.write(map[string]any{"type": "text-delta", "id": w.textID, "delta": delta})
}

// Data 写出 data-* 自定义 part，例如 data-intent-route。
func (w *Writer) Data(partType string, data any, opts DataOptions) {
	payload := map[string]any{
		"type": partType,
		"data": data,
	}
	if opts.ID != "" {
		payload["id"] = opts.ID
	}
	if opts.Transient {
		payload["transient"] = true
	}
	w.write(payload)
}

func (w *Writer) ToolInputStart(toolCallID, toolName string) {
	w.write(map[string]any{
		"type":       "tool-input-start",
		"toolCallId": toolCallID,
		"toolName":   toolName,
	})
}

func (w *Writer) ToolInputDelta(toolCallID, delta string) {
	if delta == "" {
		return
	}
	w.write(map[string]any{
		"type":           "tool-input-delta",
		"toolCallId":     toolCallID,
		"inputTextDelta": delta,
	})
}

func (w *Writer) ToolInputAvailable(toolCallID, toolName string, input any) {
	w.write(map[string]any{
		"type":       "tool-input-available",
		"toolCallId": toolCallID,
		"toolName":   toolName,
		"input":      input,
	})
}

func (w *Writer) ToolOutputAvailable(toolCallID string, output any) {
	w.write(map[string]any{
		"type":       "tool-output-available",
		"toolCallId": toolCallID,
		"output":     output,
	})
}

func (w *Writer) ToolOutputError(toolCallID, errorText string) {
	w.write(map[string]any{
		"type":       "tool-output-error",
		"toolCallId": toolCallID,
		"errorText":  errorText,
	})
}

func (w *Writer) StepStart(stepID string) {
	w.write(map[string]any{"type": "start-step", "stepId": stepID})
}

func (w *Writer) Finish() {
	w.stateMu.Lock()
	textOpen := w.textOpen
	w.stateMu.Unlock()
	if textOpen {
		w.write(map[string]any{"type": "text-end", "id": w.textID})
	}
	w.write(map[string]any{"type": "finish"})
	_, _ = io.WriteString(w.w, "data: [DONE]\n\n")
	if w.flusher != nil {
		w.flusher.Flush()
	}
}

func (w *Writer) Error(msg string) {
	w.write(map[string]any{"type": "error", "errorText": msg})
	_, _ = io.WriteString(w.w, "data: [DONE]\n\n")
	if w.flusher != nil {
		w.flusher.Flush()
	}
}

func (w *Writer) write(payload map[string]any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	_, _ = fmt.Fprintf(w.w, "data: %s\n\n", raw)
	if w.flusher != nil {
		w.flusher.Flush()
	}
}
