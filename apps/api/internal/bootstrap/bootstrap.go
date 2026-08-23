// Package bootstrap 启动期的 LLM 注入点接线：
//
//   - site-graph 生成器：adminpanel.SiteGraphGeneratorFn（实现见 adminpanel/sitegraph_llm.go）；
//   - KB 导入视觉 OCR 与后台任务循环：kb.VisionPageConverter / kb.StartImportJob
//     （实现见 kb/import_vision.go），其模型调用经由 kb.VisionChatInvoker 在本包接入 aicore——
//     kb 不能直接 import aicore（WireInvokers 反向依赖 kb 构成环）。
package bootstrap

import (
	"context"
	"log/slog"

	"petrichor/api/internal/adminpanel"
	"petrichor/api/internal/aicore"
	"petrichor/api/internal/kb"
)

// WireLLM 在 aicore.WireInvokers 之后调用；重复调用幂等。
func WireLLM() {
	if adminpanel.SiteGraphGeneratorFn == nil {
		adminpanel.SiteGraphGeneratorFn = adminpanel.SiteGraphLLMGenerator
	}
	if kb.VisionPageConverter == nil {
		kb.VisionPageConverter = kb.RunVisionPageConversion
	}
	if kb.StartImportJob == nil {
		kb.StartImportJob = kb.StartImportJobProcessing
	}
	if kb.VisionChatInvoker == nil {
		kb.VisionChatInvoker = visionChatInvoker
	}
	slog.Info("[bootstrap] site-graph / KB 导入视觉 LLM 注入点已接线")
}

// visionChatInvoker VISION 用途的多模态补全：system 提示 + [整页图片, 转写指令] 单轮调用，
// modelRefID 非空时优先钉定任务锁定的模型（对应 TS resolveLanguageModel(pinned)）。
func visionChatInvoker(ctx context.Context, userID int64, modelRefID *int64,
	systemPrompt, userPrompt string, image kb.VisionImageInput) (string, error) {

	resolved, err := aicore.ResolveModelForPurpose(ctx, userID, aicore.PurposeVision, modelRefID)
	if err != nil {
		return "", err
	}
	rt := resolved.Runtime
	rt.Quirks = aicore.ResolveQuirks(rt.ProviderKey, resolved.ModelRef)

	msgs := []aicore.ChatMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Parts: []aicore.MediaPart{
			{Type: "image_url", MIMEType: image.MIMEType, Data: image.Data},
			{Type: "text", Text: userPrompt},
		}},
	}
	result, err := aicore.Chat(ctx, rt, resolved.ModelRef, msgs, resolved.Options)
	if err != nil {
		return "", err
	}
	return result.Answer, nil
}
