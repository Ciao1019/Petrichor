package publicqa

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/components/tool/utils"
)

type publicID int64

func (id *publicID) UnmarshalJSON(data []byte) error {
	var raw string
	if json.Unmarshal(data, &raw) != nil {
		var number json.Number
		if json.Unmarshal(data, &number) != nil {
			return fmt.Errorf("ID 必须是字符串或数字")
		}
		raw = number.String()
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fmt.Errorf("ID 必须是正整数")
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return fmt.Errorf("ID 必须是正整数")
		}
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return fmt.Errorf("ID 必须是正整数")
	}
	*id = publicID(value)
	return nil
}

func (h *Handler) buildPublicQATools(scope publicArticleScope) []tool.BaseTool {
	return []tool.BaseTool{
		mustPublicTool("show_agent_plan", "当问题需要多步检索、阅读、分析时，先展示清晰执行计划。", func(_ context.Context, input *map[string]any) (map[string]any, error) {
			return withPublicToolID("plan", input), nil
		}),
		mustPublicTool("show_progress", "展示当前检索、阅读、分析的执行进度。", func(_ context.Context, input *map[string]any) (map[string]any, error) {
			return withPublicToolID("progress", input), nil
		}),
		mustPublicTool("list_public_articles", "列出本站全部公开可访问文章，含 articleId、标题、摘要和公开页链接。", func(_ context.Context, input *publicArticleListInput) (map[string]any, error) {
			return listPublicArticleItems(scope, input.Limit, input.Offset), nil
		}),
		mustPublicTool("search_public_articles", "在公开文章标题、摘要和正文中检索，回答具体内容问题前优先调用。", func(_ context.Context, input *publicArticleSearchInput) (map[string]any, error) {
			query := strings.TrimSpace(input.Query)
			if query == "" {
				return map[string]any{"query": query, "items": []any{}, "emptyMessage": "没有匹配的公开文章"}, nil
			}
			return map[string]any{"query": query, "items": searchPublicArticleItems(scope, query, input.Limit), "emptyMessage": "没有匹配的公开文章"}, nil
		}),
		mustPublicTool("read_source_article", "读取公开文章源文档全文并返回媒体引用。", func(_ context.Context, input *publicSourceInput) (map[string]any, error) {
			return readPublicSourceArticle(scope, int64(input.ArticleID))
		}),
		mustPublicTool("show_citations", "渲染最终答案使用的公开文章引用。", func(_ context.Context, input *map[string]any) (map[string]any, error) {
			result := withPublicToolID("citations", input)
			result["variant"] = "default"
			return result, nil
		}),
		mustPublicTool("show_data_table", "把结构化对比、清单或矩阵渲染为表格。", func(_ context.Context, input *map[string]any) (map[string]any, error) {
			result := copyPublicMap(input)
			if result["data"] == nil {
				result["data"] = []any{}
			}
			result["emptyMessage"] = "暂无数据"
			return result, nil
		}),
	}
}

func mustPublicTool[I, O any](name, description string, handler func(context.Context, *I) (O, error)) tool.InvokableTool {
	created, err := utils.InferTool(name, description, handler)
	if err != nil {
		panic(err)
	}
	return created
}

type publicArticleListInput struct {
	Limit  int `json:"limit,omitempty"`
	Offset int `json:"offset,omitempty"`
}

type publicArticleSearchInput struct {
	Query string `json:"query"`
	Limit int    `json:"limit,omitempty"`
}

type publicSourceInput struct {
	ArticleID publicID `json:"articleId"`
}

func copyPublicMap(input *map[string]any) map[string]any {
	result := make(map[string]any)
	if input != nil {
		for key, value := range *input {
			result[key] = value
		}
	}
	return result
}

func withPublicToolID(prefix string, input *map[string]any) map[string]any {
	result := copyPublicMap(input)
	result["id"] = fmt.Sprintf("%s-%d", prefix, time.Now().UnixMilli())
	return result
}

func readPublicSourceArticle(scope publicArticleScope, articleID int64) (map[string]any, error) {
	ref, err := requirePublicArticle(scope, articleID)
	if err != nil {
		return nil, err
	}
	idText := formatPublicID(ref.ArticleID)
	title := ref.Title
	return map[string]any{
		"type": "source", "knowledgeBaseId": formatPublicID(ref.KnowledgeBaseID),
		"articleId": idText,
		"shareCode": ref.ShareCode, "href": publicArticleHref(ref.ShareCode),
		"title": ref.Title, "contentMd": ref.Article.ContentMd,
		"media": extractPublicMedia(ref.Article.ContentMd, &idText, &title),
	}, nil
}

func sortedPublicToolNames(tools []tool.BaseTool) []string {
	names := make([]string, 0, len(tools))
	for _, publicTool := range tools {
		if info, err := publicTool.Info(context.Background()); err == nil {
			names = append(names, info.Name)
		}
	}
	sort.Strings(names)
	return names
}
