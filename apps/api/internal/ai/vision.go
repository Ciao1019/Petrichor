package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

// 文档页面 OCR 的统一系统提示词，供 Go API 的导入流程直接使用。
var DOCUMENT_VISION_SYSTEM_PROMPT = strings.Join([]string{
	"你是一个把文档页面图片转写为 Markdown 的引擎。",
	"你会收到文档「某一页」的整页图片，请把该页全部可见内容忠实转写为 GitHub Flavored Markdown。",
	"",
	"要求：",
	"1. 严格保留原文语言、文字内容与阅读顺序，不要翻译、不要总结、不要补充原文没有的内容。",
	"2. 还原结构：标题用 #/##/###，列表用 -/1.，引用用 >，代码用围栏代码块，表格用 Markdown 表格。",
	"3. 数学公式用 LaTeX：行内用 $...$，独立公式用 $$...$$。",
	"4. 页面里的照片、插图、图表、示意图等无法用文字表达的图像，用一行斜体说明代替，格式为 `*（图：简要描述）*`。",
	"   不要输出任何 Markdown 图片语法（不要写 `![...](...)`），因为没有可引用的图片地址。",
	"   图表中如果有可读的数据表，优先按 Markdown 表格转写出来，再补一行图说明。",
	"5. 页眉、页脚、页码等与正文无关的边角信息可以忽略。",
	"6. 不要输出任何解释性文字、不要用 ```markdown 包裹整体，直接输出 Markdown 正文本身。",
	"7. 如果该页为空白页，输出空字符串。",
}, "\n")

const DOCUMENT_VISION_USER_PROMPT = "请把这一页转写为 Markdown。"

var markdownFenceRE = regexp.MustCompile("(?is)^```(?:markdown|md)?\\s*\\n([\\s\\S]*?)\\n```$")

// CallVision 调用 OpenAI 兼容多模态 /chat/completions，将整页图片转写为 Markdown。
func CallVision(ctx context.Context, gen *Generation, modelCfg *ent.AIModelConfig, imageDataURL string) (string, error) {
	imageURL := strings.TrimSpace(imageDataURL)
	if imageURL == "" {
		return "", response.BadRequest("缺少待识别的页面图片")
	}
	if modelCfg == nil {
		return "", response.BadRequest("缺少多模态模型配置")
	}
	protocol := strings.ToUpper(strings.TrimSpace(modelCfg.Protocol))
	if protocol == "GEMINI" {
		return "", response.BadRequest("GEMINI 协议已禁用，请使用 OPENAI / DEEPSEEK / OPENAI_COMPAT / SILICONFLOW")
	}
	if protocol != "OPENAI" && protocol != "DEEPSEEK" && protocol != "OPENAI_COMPAT" && protocol != "SILICONFLOW" {
		return "", response.BadRequest("协议类型不能为空")
	}
	apiKey, err := gen.ResolveAPIKey(modelCfg)
	if err != nil {
		return "", response.BadRequest("VISION 配置缺少 API Key")
	}
	if modelCfg.BaseURL == nil || strings.TrimSpace(*modelCfg.BaseURL) == "" {
		return "", response.BadRequest("BaseUrl 不能为空")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(*modelCfg.BaseURL), "/")
	endpoint := baseURL + "/chat/completions"
	body := map[string]any{
		"model":  modelCfg.Model,
		"stream": false,
		"messages": []any{
			map[string]any{
				"role":    "system",
				"content": DOCUMENT_VISION_SYSTEM_PROMPT,
			},
			map[string]any{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": DOCUMENT_VISION_USER_PROMPT},
					map[string]any{
						"type":      "image_url",
						"image_url": map[string]any{"url": imageURL},
					},
				},
			},
		},
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := gen.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode >= 300 {
		return "", response.BadRequest(fmt.Sprintf("调用多模态接口失败：HTTP %d（%s）", resp.StatusCode, truncate(string(raw), 200)))
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", err
	}
	content := ""
	if len(parsed.Choices) > 0 {
		content = extractMessageText(parsed.Choices[0].Message.Content)
	}
	return normalizeMarkdown(content), nil
}

// ResolveVisionConfig 解析多模态配置：优先 VISION / MULTIMODAL，否则回退到已启用的 CHAT。
func ResolveVisionConfig(ctx context.Context, client *ent.Client, userID int64, configID *int64) (*ent.AIModelConfig, error) {
	if configID != nil && *configID > 0 {
		row, err := client.AIModelConfig.Query().
			Where(aimodelconfig.IDEQ(*configID), aimodelconfig.UserIDEQ(userID)).
			Only(ctx)
		if err != nil {
			if ent.IsNotFound(err) {
				return nil, response.NotFound("VISION 配置不存在")
			}
			return nil, err
		}
		if !row.Enabled {
			return nil, response.BadRequest("模型配置未启用")
		}
		if row.ConfigType != "VISION" {
			return nil, response.BadRequest("配置类型不是 VISION")
		}
		return row, nil
	}

	row, err := client.AIModelConfig.Query().
		Where(
			aimodelconfig.UserIDEQ(userID),
			aimodelconfig.ConfigTypeEQ("VISION"),
			aimodelconfig.IsDefaultEQ(true),
			aimodelconfig.EnabledEQ(true),
		).
		Order(ent.Asc(aimodelconfig.FieldID)).
		First(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.BadRequest("未找到可用的默认配置：VISION（请先在「模型配置 → 多模态」中新增并设为默认）")
		}
		return nil, err
	}
	return row, nil
}

func extractMessageText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &parts); err == nil {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	return ""
}

func normalizeMarkdown(raw string) string {
	text := strings.TrimSpace(raw)
	if text == "" {
		return ""
	}
	if m := markdownFenceRE.FindStringSubmatch(text); len(m) == 2 {
		return strings.TrimSpace(m[1])
	}
	return text
}
