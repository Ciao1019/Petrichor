// Package publicscope 提供所有匿名公开入口共用的内容可见性边界。
//
// 密码分享、过期分享、已撤销或禁用分享以及阅后即焚内容都不属于匿名公开范围。
// Wiki 页面还必须保证每一条来源引用都落在该范围内，避免混合来源页面泄露私有内容。
package publicscope

import (
	"context"

	"petrichor/api/internal/db"
)

// ShareVisibilityWhere 是匿名公开文章统一使用的 SQL 条件，调用查询时分享表别名必须为 s。
// 分享详情接口不使用它，因为带密码的直达链接仍需在校验密码后允许访问。
const ShareVisibilityWhere = `s.enabled = true AND s.revoked_at IS NULL
	AND (s.password_hash IS NULL OR btrim(s.password_hash) = '')
	AND (s.expires_at IS NULL OR s.expires_at > now())
	AND COALESCE(btrim(s.share_code), '') <> ''`

// ArticleRef 是匿名公开文章的最小稳定引用。
type ArticleRef struct {
	ArticleID       int64
	UserID          int64
	KnowledgeBaseID int64
	ShareCode       string
	Title           string
}

// LoadArticles 返回当前全部匿名公开文章。分享状态会按数据库当前时间实时判断。
func LoadArticles(ctx context.Context) (map[int64]*ArticleRef, error) {
	rows, err := db.Pool().Query(ctx,
		`SELECT a.id, a.user_id, a.knowledge_base_id, a.title, s.share_code
		 FROM petrichor_kb_article_share s
		 JOIN petrichor_kb_article a ON a.id = s.article_id
		 WHERE `+ShareVisibilityWhere)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	scope := map[int64]*ArticleRef{}
	for rows.Next() {
		var ref ArticleRef
		if err := rows.Scan(&ref.ArticleID, &ref.UserID, &ref.KnowledgeBaseID, &ref.Title, &ref.ShareCode); err != nil {
			return nil, err
		}
		scope[ref.ArticleID] = &ref
	}
	return scope, rows.Err()
}

const safeWikiPageIDsQuery = `SELECT p.id
	 FROM petrichor_kb_wiki_page p
	 WHERE p.archived_at IS NULL
	   AND p.kind NOT IN ('index', 'log')
	   AND ($1::bigint IS NULL OR p.knowledge_base_id = $1)
	   AND EXISTS (
	     SELECT 1 FROM petrichor_kb_wiki_source_ref source_ref
	     WHERE source_ref.page_id = p.id
	   )
	   AND NOT EXISTS (
	     SELECT 1
	     FROM petrichor_kb_wiki_source_ref source_ref
	     LEFT JOIN petrichor_kb_article_share s
	       ON s.article_id = source_ref.article_id
	      AND ` + ShareVisibilityWhere + `
	     WHERE source_ref.page_id = p.id AND s.article_id IS NULL
	   )
	 ORDER BY p.id ASC`

// LoadSafeWikiPageIDs 返回可匿名读取的 Wiki 页面 ID。
//
// 第一条 EXISTS 要求页面确实拥有来源；第二条 NOT EXISTS 保证不存在任何私有来源。
// index 是聚合页面，公开端应按安全页面集合动态生成目录，不能直接读取存量正文。
// log 属于内部构建记录，永不公开。
func LoadSafeWikiPageIDs(ctx context.Context, knowledgeBaseID *int64) ([]int64, error) {
	rows, err := db.Pool().Query(ctx, safeWikiPageIDsQuery, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// IDSet 把页面 ID 列表转成适合做邻居过滤的集合。
func IDSet(ids []int64) map[int64]struct{} {
	set := make(map[int64]struct{}, len(ids))
	for _, id := range ids {
		set[id] = struct{}{}
	}
	return set
}
