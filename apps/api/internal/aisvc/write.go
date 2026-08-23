// write.go 对照 write/{handlers,actions,prompt}.ts：编辑器内置 AI 写作助手。
// RequireUser → 解析 CHAT 绑定模型 → text/plain 流式输出。
// 与 TS 一致：所有错误都发生在流开始之前，以统一 JSON 错误体返回并断流；
// 流开始后出错则直接结束输出（前端拿到不完整文本）。
package aisvc

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	httpx "petrichor/api/internal/httpx"
)

// ===== 操作枚举（actions.ts 移植）=====

var writeActions = []string{"continue", "rewrite", "expand", "shorten", "translate", "tone"}

var translateLanguages = []string{"zh", "en", "ja", "ko", "fr", "es"}

var tonePresets = []string{"professional", "casual", "friendly", "concise", "academic"}

var translateLanguageLabels = map[string]string{
	"zh": "中文（简体）",
	"en": "英文",
	"ja": "日文",
	"ko": "韩文",
	"fr": "法文",
	"es": "西班牙文",
}

var tonePresetLabels = map[string]string{
	"professional": "专业",
	"casual":       "轻松",
	"friendly":     "友好",
	"concise":      "简洁",
	"academic":     "学术",
}

type writeRequestPayload struct {
	action        string
	selectedText  string
	contextBefore string
	contextAfter  string
	language      *string
	tone          *string
}

const (
	maxSelectedChars = 8000
	maxContextChars  = 4000
)

func isWriteAction(v string) bool {
	for _, action := range writeActions {
		if action == v {
			return true
		}
	}
	return false
}

func isTranslateLanguage(v *string) bool {
	return v != nil && containsString(translateLanguages, *v)
}

func isTonePreset(v *string) bool {
	return v != nil && containsString(tonePresets, *v)
}

func containsString(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

// validateWriteRequest 复刻 validateWriteRequest。
func validateWriteRequest(raw map[string]any) (*writeRequestPayload, error) {
	action := flexToString(raw["action"])
	if !isWriteAction(action) {
		return nil, badRequestMsg("不支持的写作操作")
	}
	selectedText := clampWriteText(stringValueOrEmpty(raw["selectedText"]), maxSelectedChars, "both")
	contextBefore := clampWriteText(stringValueOrEmpty(raw["contextBefore"]), maxContextChars, "head")
	contextAfter := clampWriteText(stringValueOrEmpty(raw["contextAfter"]), maxContextChars, "tail")

	if action != "continue" && selectedText == "" {
		return nil, badRequestMsg("请先选中要操作的文本")
	}
	if action == "continue" && contextBefore == "" && selectedText == "" {
		return nil, badRequestMsg("没有可续写的上文")
	}

	var language *string
	if raw["language"] != nil {
		v := flexToString(raw["language"])
		language = &v
	}
	var tone *string
	if raw["tone"] != nil {
		v := flexToString(raw["tone"])
		tone = &v
	}

	if action == "translate" && !isTranslateLanguage(language) {
		return nil, badRequestMsg("请选择翻译目标语言")
	}
	if action == "tone" && !isTonePreset(tone) {
		return nil, badRequestMsg("请选择目标语气")
	}

	payload := &writeRequestPayload{
		action:        action,
		selectedText:  selectedText,
		contextBefore: contextBefore,
		contextAfter:  contextAfter,
	}
	if isTranslateLanguage(language) {
		payload.language = language
	}
	if isTonePreset(tone) {
		payload.tone = tone
	}
	return payload, nil
}

func stringValueOrEmpty(v any) string {
	s, _ := v.(string)
	return s
}

// clampWriteText 大段上下文按「保留开头/结尾」截断，避免拼接出错位的语义。
func clampWriteText(value string, max int, keep string) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	switch keep {
	case "head":
		return string(runes[:max]) + "\n\n[已截断]"
	case "tail":
		return "[已截断]\n\n" + string(runes[len(runes)-max:])
	default:
		half := max / 2
		return string(runes[:half]) + "\n\n[中间已截断]\n\n" + string(runes[len(runes)-half:])
	}
}

// ===== Prompt 构造（prompt.ts 移植）=====

var writeBaseRules = strings.Join([]string{
	"你是 Petrichor 编辑器内置的中文写作助手。",
	"硬性规则：",
	"- 直接输出可粘贴回编辑器的纯文本结果，不要加任何解释、前缀、引号、Markdown 代码块、章节标题。",
	"- 不要重复用户原文，除非操作明确要求保留原文。",
	"- 保持与原文一致的 Markdown 格式（段落、列表、链接、加粗等），不要新增章节标题。",
	"- 用与用户原文一致的语言风格，除非操作要求改变语言或语气。",
}, "\n")

func buildWriteSystemPrompt(action string) string {
	rules := []string{writeBaseRules}
	switch action {
	case "continue":
		return strings.Join(append(rules,
			"本次任务：续写。",
			"- 基于「上文」自然延续，输出 1-3 段新内容，约 80-300 字。",
			"- 不要重复上文中已经表达的观点，从上文结束之处自然延伸。",
			"- 不要以「接下来」「综上所述」等模板化短语开头。",
		), "\n")
	case "rewrite":
		return strings.Join(append(rules,
			"本次任务：改写选中文本。",
			"- 保留原意与关键信息，改换表达方式与措辞。",
			"- 输出长度与原文相近，不要刻意拉长或精简。",
		), "\n")
	case "expand":
		return strings.Join(append(rules,
			"本次任务：扩展选中文本。",
			"- 在原意基础上补充背景、细节、例子或论证，使内容更丰满。",
			"- 输出长度约为原文 1.5-2.5 倍，保持自然过渡，避免堆砌。",
		), "\n")
	case "shorten":
		return strings.Join(append(rules,
			"本次任务：精简选中文本。",
			"- 保留核心信息，剔除冗余修饰、重复说法与无关细节。",
			"- 输出长度约为原文 40-60%，保持表达通顺。",
		), "\n")
	case "translate":
		return strings.Join(append(rules,
			"本次任务：翻译选中文本。",
			"- 译文要符合目标语言的自然表达习惯，不要直译。",
			"- 保留原文 Markdown 标记与变量名／代码片段不变。",
			"- 专有名词如无通用译法，可保留原文。",
		), "\n")
	case "tone":
		return strings.Join(append(rules,
			"本次任务：调整选中文本的语气。",
			"- 保留原意与事实，只改变语气与措辞。",
			"- 输出长度与原文相近。",
		), "\n")
	}
	return strings.Join(rules, "\n")
}

func buildWriteUserMessage(payload *writeRequestPayload) (string, error) {
	sections := []string{}
	switch payload.action {
	case "continue":
		sections = append(sections, "=== 上文 ===")
		if payload.contextBefore != "" {
			sections = append(sections, payload.contextBefore)
		} else {
			sections = append(sections, "（无）")
		}
		if payload.selectedText != "" {
			sections = append(sections, "", "=== 用户选中的引导文字（请基于此自然续写） ===", payload.selectedText)
		}
		if payload.contextAfter != "" {
			sections = append(sections, "", "=== 下文（仅供参考，避免与之冲突，但不要重复其内容） ===", payload.contextAfter)
		}
		sections = append(sections, "", "请输出续写内容。")
	case "rewrite", "expand", "shorten":
		if payload.contextBefore != "" {
			sections = append(sections, "=== 上文（仅供理解语境） ===", payload.contextBefore, "")
		}
		sections = append(sections, "=== 选中文本 ===", payload.selectedText)
		if payload.contextAfter != "" {
			sections = append(sections, "", "=== 下文（仅供理解语境） ===", payload.contextAfter)
		}
		sections = append(sections, "", "请输出"+writeActionLabel(payload.action)+"后的结果。")
	case "translate":
		if payload.language == nil {
			return "", errors.New("missing language")
		}
		sections = append(sections,
			"=== 翻译目标语言："+translateLanguageLabels[*payload.language]+" ===",
			"",
			"=== 选中文本 ===",
			payload.selectedText,
			"",
			"请输出译文。")
	case "tone":
		if payload.tone == nil {
			return "", errors.New("missing tone")
		}
		sections = append(sections,
			"=== 目标语气："+tonePresetLabels[*payload.tone]+" ===",
			"",
			"=== 选中文本 ===",
			payload.selectedText,
			"",
			"请输出调整后的文本。")
	}
	return strings.Join(sections, "\n"), nil
}

func writeActionLabel(action string) string {
	switch action {
	case "rewrite":
		return "改写"
	case "expand":
		return "扩展"
	case "shorten":
		return "精简"
	default:
		return action
	}
}

// ===== 流式接口 =====

var errWriteClientClosed = errors.New("客户端已断开")

// StreamWrite POST /api/ai/write/stream。
func StreamWrite(c *gin.Context) {
	user := auth.CurrentUser(c)
	var body map[string]any
	if err := httpx.ReadJSON(c, &body); err != nil {
		httpx.HandleError(c, err)
		return
	}
	payload, err := validateWriteRequest(body)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	ctx := c.Request.Context()
	resolved, err := aicore.ResolveModelForPurpose(ctx, user.ID, aicore.PurposeChat, nil)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	userMessage, err := buildWriteUserMessage(payload)
	if err != nil {
		httpx.HandleError(c, badRequestMsg("%s", err.Error()))
		return
	}

	w := c.Writer
	header := w.Header()
	header.Set("Content-Type", "text/plain; charset=utf-8")
	header.Set("Cache-Control", "no-store")
	header.Set("X-Accel-Buffering", "no")
	header.Set("X-Petrichor-Write-Action", payload.action)
	w.WriteHeader(http.StatusOK)

	temperature := 0.4
	// 与 TS 一致：write 流不读绑定参数，但 disableThinkingForTools 沿用默认 true，
	// 支持 thinking 开关的供应商会带上 thinking=disabled，避免输出思考过程。
	opts := aicore.GenerationOptions{Temperature: &temperature, DisableThinkingForTools: boolPtr(true)}
	msgs := []aicore.ChatMessage{
		{Role: "system", Content: buildWriteSystemPrompt(payload.action)},
		{Role: "user", Content: userMessage},
	}

	rt := resolved.Runtime
	rt.Quirks = aicore.ResolveQuirks(rt.ProviderKey, resolved.ModelRef)

	// TS 的 toTextStream 不做任何分帧包装，这里同样原样透传增量文本。
	// 流开始后出错不再改写响应头，直接结束输出即可。
	_, _ = aicore.ChatStream(ctx, rt, resolved.ModelRef, msgs, opts, func(delta string) error {
		if _, werr := w.WriteString(delta); werr != nil {
			return errWriteClientClosed
		}
		w.Flush()
		return nil
	})
}
