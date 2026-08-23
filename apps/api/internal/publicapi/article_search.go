// article_search.go 复刻 publicArticleSearch：pg_trgm 相似度 + ILIKE 过滤的公开检索。
package publicapi

import (
	"strings"

	"github.com/gin-gonic/gin"

	httpx "petrichor/api/internal/httpx"
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
	offset := parseBoundedNumber(queryParams["offset"], 0, 0, int64(^uint64(0)>>1))
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

const searchScoreSQL = `(
	similarity(a.title, $3) * 4
	+ similarity(coalesce(a.public_excerpt, ''), $3) * 2
	+ similarity(coalesce(a.ai_summary, ''), $3) * 2
	+ similarity(coalesce(a.content_md, ''), $3)
)`

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
	likePattern := "%" + escapeLikePattern(input.keyword) + "%"
	rows, qerr := pool().Query(ctx,
		`SELECT `+shareJoinColumns+`, `+searchScoreSQL+` AS score
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE s.enabled = true AND s.revoked_at IS NULL
		   AND (
		     a.title ILIKE $1
		     OR coalesce(a.public_excerpt, '') ILIKE $1
		     OR coalesce(a.ai_summary, '') ILIKE $1
		     OR coalesce(a.content_md, '') ILIKE $1
		   )
		 ORDER BY s.pin_order IS NULL, s.pin_order DESC, score DESC, a.updated_at DESC, s.id DESC
		 LIMIT $2 OFFSET $4`,
		likePattern, input.limit, input.keyword, input.offset)
	if qerr != nil {
		httpx.HandleError(c, qerr)
		return
	}

	type scoredRow struct {
		shareListRow
		score float64
	}
	list := []*scoredRow{}
	for rows.Next() {
		var r scoredRow
		serr := rows.Scan(&r.articleID, &r.title, &r.updatedAt,
			&r.publicExcerpt, &r.publicContentHash, &r.aiSummary, &r.readingMinutes,
			&r.shareCode, &r.expiresAt, &r.passwordHash,
			&r.isRepost, &r.originalURL, &r.originalAuthorName, &r.internalURL,
			&r.pinOrder, &r.score)
		if serr != nil {
			rows.Close()
			httpx.HandleError(c, serr)
			return
		}
		list = append(list, &r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		httpx.HandleError(c, err)
		return
	}

	baseRows := make([]*shareListRow, 0, len(list))
	for _, row := range list {
		row.searchScore = row.score
		baseRows = append(baseRows, &row.shareListRow)
	}

	resp, aerr := assembleArticleItems(ctx, baseRows, timeNow(), true)
	if aerr != nil {
		httpx.HandleError(c, aerr)
		return
	}
	resp["keyword"] = input.keyword
	resp["limit"] = input.limit
	resp["offset"] = input.offset
	itemCount := int64(len(resp["items"].([]map[string]any)))
	resp["hasMore"] = itemCount == input.limit

	c.Header("Cache-Control", publicArticleSearchCacheControl)
	httpx.OK(c, resp)
}
