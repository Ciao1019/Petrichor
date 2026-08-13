package publicqa

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleshare"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type publicArticleRef struct {
	Article         *ent.KBArticle
	Share           *ent.KBArticleShare
	ArticleID       int64
	UserID          int64
	KnowledgeBaseID int64
	ShareCode       string
	Title           string
}

type publicArticleScope map[int64]publicArticleRef

func (h *Handler) loadPublicArticleScope(ctx context.Context) (publicArticleScope, error) {
	now := time.Now().UTC()
	shares, err := h.client.KBArticleShare.Query().
		Where(kbarticleshare.EnabledEQ(true), kbarticleshare.RevokedAtIsNil()).
		All(ctx)
	if err != nil {
		return nil, err
	}
	scope := make(publicArticleScope)
	for _, share := range shares {
		if share.ExpiresAt != nil && !share.ExpiresAt.After(now) {
			continue
		}
		if share.PasswordHash != nil && strings.TrimSpace(*share.PasswordHash) != "" {
			continue
		}
		article, err := h.client.KBArticle.Get(ctx, share.ArticleID)
		if err != nil {
			continue
		}
		scope[article.ID] = publicArticleRef{
			Article: article, Share: share, ArticleID: article.ID, UserID: article.UserID,
			KnowledgeBaseID: article.KnowledgeBaseID, ShareCode: share.ShareCode, Title: article.Title,
		}
	}
	return scope, nil
}

func requirePublicArticle(scope publicArticleScope, articleID int64) (publicArticleRef, error) {
	ref, ok := scope[articleID]
	if !ok {
		return publicArticleRef{}, response.NotFound("该文章不在公开范围内（仅支持已公开分享的文章）")
	}
	return ref, nil
}

func publicArticleHref(shareCode string) string {
	return "/p/" + shareCode
}

func publicArticleSnippet(article *ent.KBArticle) string {
	for _, candidate := range []*string{article.AiSummary, article.PublicExcerpt} {
		if candidate != nil && strings.TrimSpace(*candidate) != "" {
			return truncatePublicText(strings.TrimSpace(*candidate), 320)
		}
	}
	plain := strings.Join(strings.Fields(article.ContentMd), " ")
	if plain == "" {
		return "（无摘要，可调用 read_source_article 查看全文）"
	}
	return truncatePublicText(plain, 320)
}

func truncatePublicText(value string, limit int) string {
	if limit <= 0 || utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit]) + "…"
}

func listPublicArticleItems(scope publicArticleScope, limit, offset int) map[string]any {
	if limit <= 0 {
		limit = 30
	}
	if limit > 50 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	refs := make([]publicArticleRef, 0, len(scope))
	for _, ref := range scope {
		refs = append(refs, ref)
	}
	sort.SliceStable(refs, func(i, j int) bool {
		left, right := refs[i], refs[j]
		if (left.Share.PinOrder != nil) != (right.Share.PinOrder != nil) {
			return left.Share.PinOrder != nil
		}
		if left.Share.PinOrder != nil && right.Share.PinOrder != nil && *left.Share.PinOrder != *right.Share.PinOrder {
			return *left.Share.PinOrder > *right.Share.PinOrder
		}
		if !left.Article.UpdatedAt.Equal(right.Article.UpdatedAt) {
			return left.Article.UpdatedAt.After(right.Article.UpdatedAt)
		}
		return left.Share.ID > right.Share.ID
	})
	total := len(refs)
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	items := make([]map[string]any, 0, end-offset)
	for _, ref := range refs[offset:end] {
		items = append(items, publicArticleItem(ref))
	}
	result := map[string]any{"total": total, "items": items}
	if total == 0 {
		result["emptyMessage"] = "本站暂无公开文章"
	}
	return result
}

func publicArticleItem(ref publicArticleRef) map[string]any {
	return map[string]any{
		"articleId": formatPublicID(ref.ArticleID), "shareCode": ref.ShareCode,
		"href": publicArticleHref(ref.ShareCode), "title": ref.Title,
		"snippet":   publicArticleSnippet(ref.Article),
		"updatedAt": ref.Article.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func searchPublicArticleItems(scope publicArticleScope, query string, limit int) []map[string]any {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return []map[string]any{}
	}
	if limit <= 0 {
		limit = 8
	}
	if limit > 20 {
		limit = 20
	}
	type scored struct {
		ref   publicArticleRef
		score int
	}
	rows := make([]scored, 0, len(scope))
	terms := strings.Fields(query)
	if len(terms) == 0 {
		terms = []string{query}
	}
	for _, ref := range scope {
		title := strings.ToLower(ref.Title)
		summary := strings.ToLower(publicArticleSnippet(ref.Article))
		content := strings.ToLower(ref.Article.ContentMd)
		score := 0
		for _, term := range terms {
			if strings.Contains(title, term) {
				score += 8
			}
			if strings.Contains(summary, term) {
				score += 4
			}
			if strings.Contains(content, term) {
				score++
			}
		}
		if score > 0 {
			rows = append(rows, scored{ref: ref, score: score})
		}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].score != rows[j].score {
			return rows[i].score > rows[j].score
		}
		return rows[i].ref.Article.UpdatedAt.After(rows[j].ref.Article.UpdatedAt)
	})
	if len(rows) > limit {
		rows = rows[:limit]
	}
	items := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		items = append(items, publicArticleItem(row.ref))
	}
	return items
}

func formatPublicID(id int64) string {
	// 独立小函数便于所有公开工具保持 bigint -> string 契约。
	return fmt.Sprintf("%d", id)
}
