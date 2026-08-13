package kb

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type MindmapMode string

const (
	MindmapModeOutline MindmapMode = "MINDMAP"

	mindmapMaxModelInputChars = 12000
	mindmapMaxNodeCount       = 120
	mindmapMaxDepth           = 6
	mindmapMaxTopicLength     = 80
)

var (
	mindmapFenceOpenRE  = regexp.MustCompile(`(?i)^` + "```" + `(?:json)?\s*`)
	mindmapFenceCloseRE = regexp.MustCompile(`(?i)\s*` + "```" + `$`)
	headingLineRE       = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*$`)
)

type MindmapNode struct {
	ID        string        `json:"id,omitempty"`
	Topic     string        `json:"topic"`
	Root      *bool         `json:"root,omitempty"`
	Expanded  *bool         `json:"expanded,omitempty"`
	Direction *int          `json:"direction,omitempty"`
	Children  []MindmapNode `json:"children,omitempty"`
}

type MindmapData struct {
	NodeData MindmapNode `json:"nodeData"`
}

type MindmapGenerateInput struct {
	ArticleID    int64
	Mode         MindmapMode
	ForceRebuild bool
}

type MindmapGenerateResult struct {
	ArticleID   string
	FromCache   bool
	GeneratedAt *string
	Data        MindmapData
}

func ValidateMindmapGenerateInput(articleIDRaw, modeRaw string, forceRebuild bool) (MindmapGenerateInput, error) {
	articleIDRaw = strings.TrimSpace(articleIDRaw)
	if articleIDRaw == "" {
		return MindmapGenerateInput{}, response.BadRequest("不能为空")
	}
	id, err := parsePositiveID(articleIDRaw, "articleId")
	if err != nil {
		return MindmapGenerateInput{}, response.BadRequest(`需要匹配正则表达式"\d+"`)
	}
	mode := strings.TrimSpace(modeRaw)
	if mode != "" && mode != string(MindmapModeOutline) {
		return MindmapGenerateInput{}, response.BadRequest("mode 非法")
	}
	if mode == "" {
		mode = string(MindmapModeOutline)
	}
	return MindmapGenerateInput{
		ArticleID:    id,
		Mode:         MindmapMode(mode),
		ForceRebuild: forceRebuild,
	}, nil
}

func BuildMindmapSystemPrompt(mode MindmapMode) string {
	return strings.TrimSpace(`
你是一个“文章 → 思维导图”转换器。

请根据用户提供的文章标题与 Markdown 内容，输出一个 JSON 对象（不要输出任何解释文字、不要使用 Markdown 代码块/三个反引号包裹）。
JSON 必须符合 Mind Elixir 的 MindElixirData 最小结构：
{
  "nodeData": {
    "topic": "根主题",
    "root": true,
    "children": [
      { "topic": "子主题", "children": [ ... ] }
    ]
  }
}

规则：
- 仅使用字段：topic / children（可选）/ root（仅根节点）
- 总层级不超过 6 层
- 总节点数不超过 120 个
- topic 必须是简短中文短语（每个不超过 80 字符）
- 如果信息不足，可适度归纳，但不要虚构不存在的具体事实
`)
}

func BuildMindmapUserMessage(knowledgeBaseName, title, contentMd string) string {
	content := contentMd
	if len([]rune(content)) > mindmapMaxModelInputChars {
		content = string([]rune(content)[:mindmapMaxModelInputChars]) + "\n\n[内容已截断]"
	}
	return strings.Join([]string{
		"知识库：" + knowledgeBaseName,
		"文章标题：" + title,
		"",
		"文章 Markdown 内容：",
		content,
	}, "\n")
}

func ExtractJSONObjectText(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	text = mindmapFenceOpenRE.ReplaceAllString(text, "")
	text = mindmapFenceCloseRE.ReplaceAllString(text, "")
	text = strings.TrimSpace(text)
	start := strings.Index(text, "{")
	end := strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return "", response.BadRequest("模型未返回合法 JSON")
	}
	return text[start : end+1], nil
}

func ParseJSONOrNull(value string) any {
	text := strings.TrimSpace(value)
	if text == "" {
		return nil
	}
	var out any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		return nil
	}
	return out
}

func IsMindmapCacheHit(currentHash, storedHash, storedJSON string) bool {
	return strings.TrimSpace(storedJSON) != "" &&
		strings.TrimSpace(storedHash) != "" &&
		storedHash == currentHash
}

func NormalizeMindmapModelOutput(raw any, fallbackTitle string, mode MindmapMode) MindmapData {
	rootSource := raw
	if obj := readObject(raw); obj != nil {
		if nodeData, ok := obj["nodeData"]; ok {
			rootSource = nodeData
		}
	}
	counter := 0
	root := normalizeNode(rootSource, fallbackTitle, 1, &counter, mode)
	root.ID = "root"
	rootTrue := true
	rootExpanded := true
	root.Root = &rootTrue
	root.Expanded = &rootExpanded

	return MindmapData{NodeData: root}
}

func (s *Service) GenerateArticleMindmap(ctx context.Context, userID int64, input MindmapGenerateInput) (*MindmapGenerateResult, error) {
	article, err := s.client.KBArticle.Query().
		Where(kbarticle.IDEQ(input.ArticleID), kbarticle.UserIDEQ(userID)).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("文章不存在")
		}
		return nil, err
	}

	kbName := "知识库"
	if kb, kbErr := s.client.KnowledgeBase.Get(ctx, article.KnowledgeBaseID); kbErr == nil {
		kbName = kb.Name
	} else if !ent.IsNotFound(kbErr) {
		return nil, kbErr
	}

	contentHash := BuildMindmapContentHash(article.Title, article.ContentMd)
	articleID := fmt.Sprintf("%d", article.ID)

	storedHash, storedJSON, generatedAt := mindmapStoredFields(article, input.Mode)
	if !input.ForceRebuild && IsMindmapCacheHit(contentHash, storedHash, storedJSON) {
		data := decodeMindmapData(storedJSON, article.Title, input.Mode)
		return &MindmapGenerateResult{
			ArticleID:   articleID,
			FromCache:   true,
			GeneratedAt: formatTimePtr(generatedAt),
			Data:        data,
		}, nil
	}

	modelCfg, err := ai.ResolveChatConfig(ctx, s.client, userID)
	if err != nil {
		return nil, err
	}
	gen := ai.NewGeneration(s.cfg)
	chatResult, err := gen.Chat(ctx, modelCfg, []ai.ChatMessage{
		{Role: "system", Content: BuildMindmapSystemPrompt(input.Mode)},
		{Role: "user", Content: BuildMindmapUserMessage(kbName, article.Title, article.ContentMd)},
	})
	if err != nil {
		return nil, err
	}

	jsonText, err := ExtractJSONObjectText(chatResult.Content)
	if err != nil {
		return nil, err
	}
	var parsed any
	if err := json.Unmarshal([]byte(jsonText), &parsed); err != nil {
		return nil, response.BadRequest("模型未返回合法 JSON")
	}
	data := NormalizeMindmapModelOutput(parsed, article.Title, input.Mode)
	jsonBytes, err := json.Marshal(data)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	upd := article.Update().SetMindmapJSON(string(jsonBytes)).
		SetMindmapContentHash(contentHash).
		SetMindmapGeneratedAt(now)
	updated, err := upd.Save(ctx)
	if err != nil {
		return nil, err
	}

	_, storedJSON, generatedAt = mindmapStoredFields(updated, input.Mode)
	return &MindmapGenerateResult{
		ArticleID:   articleID,
		FromCache:   false,
		GeneratedAt: formatTimePtr(generatedAt),
		Data:        data,
	}, nil
}

func mindmapStoredFields(article *ent.KBArticle, mode MindmapMode) (hash, jsonText string, generatedAt *time.Time) {
	if article.MindmapContentHash != nil {
		hash = *article.MindmapContentHash
	}
	if article.MindmapJSON != nil {
		jsonText = *article.MindmapJSON
	}
	return hash, jsonText, article.MindmapGeneratedAt
}

func decodeMindmapData(storedJSON, fallbackTitle string, mode MindmapMode) MindmapData {
	if parsed := ParseJSONOrNull(storedJSON); parsed != nil {
		return NormalizeMindmapModelOutput(parsed, fallbackTitle, mode)
	}
	return MindmapData{NodeData: MindmapNode{Topic: trimTopic(fallbackTitle)}}
}

func normalizeNode(raw any, fallbackTopic string, depth int, counter *int, mode MindmapMode) MindmapNode {
	source := readObject(raw)
	topic := fallbackTopic
	if source != nil {
		if v, ok := source["topic"].(string); ok {
			topic = v
		}
	}
	topic = trimTopic(topic)

	id := "root"
	if *counter > 0 {
		id = fmt.Sprintf("n%d", *counter)
	}
	*counter++

	node := MindmapNode{ID: id, Topic: topic}

	var children []any
	if source != nil {
		if arr, ok := source["children"].([]any); ok {
			children = arr
		}
	}
	if depth < mindmapMaxDepth && *counter < mindmapMaxNodeCount && len(children) > 0 {
		normalizedChildren := make([]MindmapNode, 0, len(children))
		for _, child := range children {
			if *counter >= mindmapMaxNodeCount {
				break
			}
			normalizedChildren = append(normalizedChildren, normalizeNode(child, "未命名", depth+1, counter, mode))
		}
		if len(normalizedChildren) > 0 {
			node.Children = normalizedChildren
		}
	}
	return node
}

func trimTopic(value string) string {
	v := strings.TrimSpace(value)
	if v == "" {
		v = "未命名"
	}
	runes := []rune(v)
	if len(runes) > mindmapMaxTopicLength {
		return string(runes[:mindmapMaxTopicLength])
	}
	return v
}

func readObject(raw any) map[string]any {
	obj, ok := raw.(map[string]any)
	if !ok || obj == nil {
		return nil
	}
	return obj
}

// BuildSimpleMindmapData 从 Markdown 标题提取简易导图（测试/降级用）。
func BuildSimpleMindmapData(title, contentMd string, mode MindmapMode) MindmapData {
	rootTrue := true
	rootExpanded := true
	root := MindmapNode{
		ID:       "root",
		Topic:    trimTopic(strings.TrimSpace(title)),
		Root:     &rootTrue,
		Expanded: &rootExpanded,
		Children: extractHeadingNodes(contentMd),
	}
	if len(root.Children) == 0 {
		root.Children = []MindmapNode{{ID: "n1", Topic: "内容概要"}}
	}
	return MindmapData{NodeData: root}
}

func extractHeadingNodes(contentMd string) []MindmapNode {
	lines := strings.Split(contentMd, "\n")
	type stackItem struct {
		level int
		node  *MindmapNode
	}
	var rootChildren []MindmapNode
	stack := []stackItem{}
	index := 0

	for _, line := range lines {
		line = strings.TrimRight(line, "\r")
		m := headingLineRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		level := len(m[1])
		node := MindmapNode{
			ID:    fmt.Sprintf("n%d", index+1),
			Topic: trimTopic(m[2]),
		}
		index++
		if index > mindmapMaxNodeCount {
			break
		}
		for len(stack) > 0 && stack[len(stack)-1].level >= level {
			stack = stack[:len(stack)-1]
		}
		if len(stack) == 0 {
			rootChildren = append(rootChildren, node)
			stack = append(stack, stackItem{level: level, node: &rootChildren[len(rootChildren)-1]})
			continue
		}
		parent := stack[len(stack)-1].node
		parent.Children = append(parent.Children, node)
		stack = append(stack, stackItem{level: level, node: &parent.Children[len(parent.Children)-1]})
	}
	return rootChildren
}
