package publicscope

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"petrichor/api/internal/db"
)

// source_ref 会随文章删除级联清理，但聚合正文和 contributions 未必同步更新。
// 匿名读取还需核对构建来源；无法证明来源的旧正文不进入公开范围。
func wikiMetadataIsPublic(raw *string, articles map[int64]*ArticleRef) bool {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return true
	}
	var metadata struct {
		ArticleID     json.RawMessage `json:"articleId"`
		BaseContentMd string          `json:"baseContentMd"`
		BaseSummary   string          `json:"baseSummary"`
		Contributions map[string]struct {
			ArticleID json.RawMessage `json:"articleId"`
		} `json:"contributions"`
	}
	if json.Unmarshal([]byte(*raw), &metadata) != nil {
		return false
	}
	if strings.TrimSpace(metadata.BaseContentMd) != "" || strings.TrimSpace(metadata.BaseSummary) != "" {
		return false
	}
	publicID := func(value json.RawMessage) (int64, bool) {
		var idText string
		if json.Unmarshal(value, &idText) != nil {
			idText = string(value)
		}
		id, err := strconv.ParseInt(idText, 10, 64)
		return id, err == nil && id > 0 && articles[id] != nil
	}
	if len(metadata.ArticleID) > 0 && string(metadata.ArticleID) != "null" {
		if _, ok := publicID(metadata.ArticleID); !ok {
			return false
		}
	}
	for key, contribution := range metadata.Contributions {
		id, err := strconv.ParseInt(key, 10, 64)
		if err != nil || id <= 0 || articles[id] == nil {
			return false
		}
		if len(contribution.ArticleID) > 0 {
			if entryID, ok := publicID(contribution.ArticleID); !ok || entryID != id {
				return false
			}
		}
	}
	return true
}

func filterWikiProvenance(ctx context.Context, ids []int64) ([]int64, error) {
	if len(ids) == 0 {
		return ids, nil
	}
	articles, err := LoadArticles(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := db.Pool().Query(ctx, `SELECT id, frontmatter_json
		FROM petrichor_kb_wiki_page WHERE id = ANY($1) ORDER BY id`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []int64{}
	for rows.Next() {
		var id int64
		var metadata *string
		if err := rows.Scan(&id, &metadata); err != nil {
			return nil, err
		}
		if wikiMetadataIsPublic(metadata, articles) {
			result = append(result, id)
		}
	}
	return result, rows.Err()
}
