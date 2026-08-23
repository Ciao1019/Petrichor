package aicore

import (
	"context"
	"log/slog"
	"net/url"

	"petrichor/api/internal/kb"
)

// WireInvokers 把 AI 核心接入各业务域的 LLM 注入点（对应 TS 中直接函数调用的部分）。
func WireInvokers() {
	if kb.ChatInvoker == nil {
		kb.ChatInvoker = func(ctx context.Context, req kb.ChatRequest) (string, error) {
			resolved, err := ResolveModelForPurpose(ctx, req.UserID, purposeOfOp(req.Op), nil)
			if err != nil {
				return "", err
			}
			rt := resolved.Runtime
			rt.Quirks = ResolveQuirks(rt.ProviderKey, resolved.ModelRef)
			msgs := buildMessages(req.SystemPrompt, req.Message)
			result, err := Chat(ctx, rt, resolved.ModelRef, msgs, resolved.Options)
			if err != nil {
				return "", err
			}
			return result.Answer, nil
		}
	}
	if kb.EmbedInvoker == nil {
		kb.EmbedInvoker = func(ctx context.Context, req kb.EmbedRequest) ([][]float32, error) {
			resolved, err := ResolveModelForPurpose(ctx, req.UserID, PurposeEmbedding, nil)
			if err != nil {
				return nil, err
			}
			return Embeddings(ctx, resolved.Runtime, resolved.ModelRef, req.Texts)
		}
	}
	slog.Info("[aicore] LLM 注入点已接线")
}

func purposeOfOp(op string) string {
	switch op {
	case "VISION", "vision":
		return PurposeVision
	case "DOC_QA", "doc_qa":
		return PurposeDocQA
	default:
		return PurposeChat
	}
}

func buildMessages(system, user string) []ChatMessage {
	msgs := make([]ChatMessage, 0, 2)
	if system != "" {
		msgs = append(msgs, ChatMessage{Role: "system", Content: system})
	}
	msgs = append(msgs, ChatMessage{Role: "user", Content: user})
	return msgs
}

func urlValues() url.Values { return url.Values{} }
