package write

import (
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type Handler struct {
	client *ent.Client
	cfg    *config.Config
	gen    *ai.Generation
}

func NewHandler(client *ent.Client, cfg *config.Config) *Handler {
	return &Handler{client: client, cfg: cfg, gen: ai.NewGeneration(cfg)}
}

var writeActions = map[string]bool{
	"continue":  true,
	"rewrite":   true,
	"expand":    true,
	"shorten":   true,
	"translate": true,
	"tone":      true,
}

var translateLabels = map[string]string{
	"zh": "中文（简体）",
	"en": "英文",
	"ja": "日文",
	"ko": "韩文",
	"fr": "法文",
	"es": "西班牙文",
}

var toneLabels = map[string]string{
	"professional": "专业",
	"casual":       "轻松",
	"friendly":     "友好",
	"concise":      "简洁",
	"academic":     "学术",
}

type streamRequest struct {
	Action        string `json:"action"`
	SelectedText  string `json:"selectedText"`
	ContextBefore string `json:"contextBefore"`
	ContextAfter  string `json:"contextAfter"`
	Language      string `json:"language"`
	Tone          string `json:"tone"`
}

// Stream POST：认证由上层中间件保证；以 text/plain 写出写作结果。
func (h *Handler) Stream(c *gin.Context) {
	var req streamRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	action := strings.TrimSpace(req.Action)
	if !writeActions[action] {
		response.Fail(c, response.BadRequest("不支持的写作操作"))
		return
	}
	selected := clampText(req.SelectedText, 8000, "both")
	before := clampText(req.ContextBefore, 4000, "head")
	after := clampText(req.ContextAfter, 4000, "tail")
	if action != "continue" && selected == "" {
		response.Fail(c, response.BadRequest("请先选中要操作的文本"))
		return
	}
	if action == "continue" && before == "" && selected == "" {
		response.Fail(c, response.BadRequest("没有可续写的上文"))
		return
	}
	language := strings.TrimSpace(req.Language)
	tone := strings.TrimSpace(req.Tone)
	if action == "translate" && translateLabels[language] == "" {
		response.Fail(c, response.BadRequest("请选择翻译目标语言"))
		return
	}
	if action == "tone" && toneLabels[tone] == "" {
		response.Fail(c, response.BadRequest("请选择目标语气"))
		return
	}

	u := auth.MustUser(c)
	modelCfg, err := h.resolveChatConfig(c, u.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	messages := []ai.ChatMessage{
		{Role: "system", Content: buildWriteSystemPrompt(action)},
		{Role: "user", Content: buildWriteUserMessage(action, selected, before, after, language, tone)},
	}
	started := false
	startResponse := func() {
		if started {
			return
		}
		started = true
		c.Header("Cache-Control", "no-store")
		c.Header("X-Petrichor-Write-Action", action)
		c.Header("Content-Type", "text/plain; charset=utf-8")
		c.Status(200)
	}
	temperature := 0.4
	err = h.gen.StreamChat(c.Request.Context(), modelCfg, messages, &temperature, func(delta string) error {
		startResponse()
		if _, err := c.Writer.Write([]byte(delta)); err != nil {
			return err
		}
		if f, ok := c.Writer.(interface{ Flush() }); ok {
			f.Flush()
		}
		return nil
	})
	if err != nil {
		if !started {
			response.Fail(c, err)
		}
		return
	}
	startResponse()
}

func (h *Handler) resolveChatConfig(c *gin.Context, userID int64) (*ent.AIModelConfig, error) {
	return ai.ResolveChatConfig(c.Request.Context(), h.client, userID)
}

func buildWriteSystemPrompt(action string) string {
	base := strings.Join([]string{
		"你是 Petrichor 编辑器内置的中文写作助手。",
		"硬性规则：",
		"- 直接输出可粘贴回编辑器的纯文本结果，不要加任何解释、前缀、引号、Markdown 代码块、章节标题。",
		"- 不要重复用户原文，除非操作明确要求保留原文。",
		"- 保持与原文一致的 Markdown 格式（段落、列表、链接、加粗等），不要新增章节标题。",
		"- 用与用户原文一致的语言风格，除非操作要求改变语言或语气。",
	}, "\n")
	switch action {
	case "continue":
		return base + "\n本次任务：续写。\n- 基于「上文」自然延续，输出 1-3 段新内容，约 80-300 字。\n- 不要重复上文中已经表达的观点，从上文结束之处自然延伸。\n- 不要以「接下来」「综上所述」等模板化短语开头。"
	case "rewrite":
		return base + "\n本次任务：改写选中文本。\n- 保留原意与关键信息，改换表达方式与措辞。\n- 输出长度与原文相近，不要刻意拉长或精简。"
	case "expand":
		return base + "\n本次任务：扩展选中文本。\n- 在原意基础上补充背景、细节、例子或论证，使内容更丰满。\n- 输出长度约为原文 1.5-2.5 倍，保持自然过渡，避免堆砌。"
	case "shorten":
		return base + "\n本次任务：精简选中文本。\n- 保留核心信息，剔除冗余修饰、重复说法与无关细节。\n- 输出长度约为原文 40-60%，保持表达通顺。"
	case "translate":
		return base + "\n本次任务：翻译选中文本。\n- 译文要符合目标语言的自然表达习惯，不要直译。\n- 保留原文 Markdown 标记与变量名／代码片段不变。\n- 专有名词如无通用译法，可保留原文。"
	case "tone":
		return base + "\n本次任务：调整选中文本的语气。\n- 保留原意与事实，只改变语气与措辞。\n- 输出长度与原文相近。"
	default:
		return base
	}
}

func buildWriteUserMessage(action, selected, before, after, language, tone string) string {
	var sections []string
	switch action {
	case "continue":
		sections = append(sections, "=== 上文 ===", orDash(before))
		if selected != "" {
			sections = append(sections, "", "=== 用户选中的引导文字（请基于此自然续写） ===", selected)
		}
		if after != "" {
			sections = append(sections, "", "=== 下文（仅供参考，避免与之冲突，但不要重复其内容） ===", after)
		}
		sections = append(sections, "", "请输出续写内容。")
	case "rewrite", "expand", "shorten":
		if before != "" {
			sections = append(sections, "=== 上文（仅供理解语境） ===", before, "")
		}
		sections = append(sections, "=== 选中文本 ===", selected)
		if after != "" {
			sections = append(sections, "", "=== 下文（仅供理解语境） ===", after)
		}
		label := map[string]string{"rewrite": "改写", "expand": "扩展", "shorten": "精简"}[action]
		sections = append(sections, "", fmt.Sprintf("请输出%s后的结果。", label))
	case "translate":
		sections = append(sections,
			fmt.Sprintf("=== 翻译目标语言：%s ===", translateLabels[language]),
			"",
			"=== 选中文本 ===",
			selected,
			"",
			"请输出译文。",
		)
	case "tone":
		sections = append(sections,
			fmt.Sprintf("=== 目标语气：%s ===", toneLabels[tone]),
			"",
			"=== 选中文本 ===",
			selected,
			"",
			"请输出调整后的文本。",
		)
	}
	return strings.Join(sections, "\n")
}

func orDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "（无）"
	}
	return s
}

func clampText(value string, max int, keep string) string {
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
