// article_search.go 复刻 publicArticleSearch：pg_trgm 相似度 + ILIKE 过滤的公开检索。
package publicapi

import (
	"strings"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/publicscope"
)

const (
	publicSearchMaxKeywordLength = 100
	publicSearchDefaultLimit     = 20
	publicSearchMaxLimit         = 50
)

type publicArticleSearchInput struct {
	keyword string
	limit   int64
	offset  int64
}

// parseBoundedNumber 对应 share-logic.ts 的 parseBoundedNumber：
// 非整数格式回退默认值；越界时收敛到边界。
func parseBoundedNumber(raw string, defaultValue, min, max int64) int64 {
	text := strings.TrimSpace(raw)
	if text == "" {
		return defaultValue
	}
	value, err := parseInt64(text)
	if err != nil {
		return defaultValue
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func parseInt64(text string) (int64, error) {
	var n int64
	neg := false
	for i, ch := range text {
		switch {
		case ch == '-' && i == 0 && len(text) > 1:
			neg = true
		case ch >= '0' && ch <= '9':
			n = n*10 + int64(ch-'0')
		default:
			return 0, errNotInteger
		}
	}
	if neg {
		n = -n
	}
	return n, nil
}

var errNotInteger = badReq("数值非法")

// validatePublicArticleSearchInput 复刻 validatePublicArticleSearchInput。
func validatePublicArticleSearchInput(queryParams map[string]string) (*publicArticleSearchInput, error) {
	keyword := strings.TrimSpace(firstNonEmpty(queryParams["q"], queryParams["keyword"]))
	if keyword == "" {
		return nil, badReq("请输入搜索关键字")
	}
	if runeLen(keyword) > publicSearchMaxKeywordLength {
		return nil, badReq("关键字长度不能超过 " + strconvItoa(publicSearchMaxKeywordLength))
	}
	limit := parseBoundedNumber(queryParams["limit"], publicSearchDefaultLimit, 1, publicSearchMaxLimit)
	offset := parseBoundedNumber(queryParams["offset"], 0, 0, publicSearchMaxOffset)
	return &publicArticleSearchInput{keyword: keyword, limit: limit, offset: offset}, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func runeLen(s string) int { return len([]rune(s)) }

// ArticleSearch GET /api/public/article/search。
func ArticleSearch(c *gin.Context) {
	input, err := validatePublicArticleSearchInput(map[string]string{
		"q":       c.Query("q"),
		"keyword": c.Query("keyword"),
		"limit":   c.Query("limit"),
		"offset":  c.Query("offset"),
	})
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	ctx := c.Request.Context()
	scope, err := loadPublicSearchScope(ctx)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	candidateLimit := int(input.offset + input.limit + 1)
	if candidateLimit > int(publicSearchMaxOffset+publicSearchMaxLimit+1) {
		candidateLimit = int(publicSearchMaxOffset + publicSearchMaxLimit + 1)
	}
	hits, err := lexicalPublicArticleSearch(ctx, input.keyword, scope, candidateLimit)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	start := int(input.offset)
	if start > len(hits) {
		start = len(hits)
	}
	end := start + int(input.limit)
	if end > len(hits) {
		end = len(hits)
	}
	selected := hits[start:end]
	selectedIDs := make([]int64, 0, len(selected))
	scoreByArticle := map[int64]float64{}
	for _, hit := range selected {
		selectedIDs = append(selectedIDs, hit.articleID)
		scoreByArticle[hit.articleID] = hit.lexicalScore
	}
	rowByArticle := map[int64]*shareListRow{}
	if len(selectedIDs) > 0 {
		rows, queryErr := pool().Query(ctx,
			`SELECT `+shareJoinColumns+`
			 FROM petrichor_kb_article_share s
			 JOIN petrichor_kb_article a ON a.id = s.article_id
			 WHERE `+publicscope.ShareVisibilityWhere+` AND a.id = ANY($1)
			 ORDER BY s.id DESC`, selectedIDs)
		if queryErr != nil {
			httpx.HandleError(c, queryErr)
			return
		}
		for rows.Next() {
			var row shareListRow
			if scanErr := rows.Scan(&row.articleID, &row.title, &row.updatedAt,
				&row.publicExcerpt, &row.publicContentHash, &row.aiSummary, &row.readingMinutes,
				&row.shareCode, &row.expiresAt, &row.passwordHash,
				&row.isRepost, &row.originalURL, &row.originalAuthorName, &row.internalURL,
				&row.pinOrder); scanErr != nil {
				rows.Close()
				httpx.HandleError(c, scanErr)
				return
			}
			if rowByArticle[row.articleID] == nil {
				row.searchScore = scoreByArticle[row.articleID]
				rowByArticle[row.articleID] = &row
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			httpx.HandleError(c, err)
			return
		}
	}
	baseRows := make([]*shareListRow, 0, len(selected))
	for _, hit := range selected {
		if row := rowByArticle[hit.articleID]; row != nil {
			baseRows = append(baseRows, row)
		}
	}

	resp, aerr := assembleArticleItems(ctx, baseRows, timeNow(), true)
	if aerr != nil {
		httpx.HandleError(c, aerr)
		return
	}
	resp["keyword"] = input.keyword
	resp["limit"] = input.limit
	resp["offset"] = input.offset
	resp["hasMore"] = end < len(hits)

	c.Header("Cache-Control", publicArticleSearchCacheControl)
	httpx.OK(c, resp)
}
