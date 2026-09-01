// wikimutation.go Wiki 变更的唯一入口。
//
// 一次 Wiki 写通常牵连四张表——page、link、source_ref、tree_node——外加一条审计事件，
// 顺序写错就会留下悬挂链接或孤儿引用。这些语义原本在 wiki-build、wiki-ingest、wiki2
// 三个文件里各自拼了一遍 SQL，本文件把它们收敛成一组入口：
//
//   - upsertWikiPage            创建/更新页面并整体替换来源引用
//   - replaceWikiSourceRefs     整体替换一个页面的来源引用
//   - replaceWikiPageLinks      整体替换一个页面的出链
//   - replaceWikiPageLinksBatch 批量替换多个页面的出链
//   - setWikiPatchStatus        流转补丁状态
//   - deleteWikiPagesCascade    删除页面及其全部派生数据
//   - deleteWikiPageByKey       按 page key 删除单页
//   - logWikiEvent              写审计事件
//
// 业务代码不应再直接拼写 page / link / source_ref / patch / event_log 的写 SQL。
// 两处仍在本文件之外直接写库，都是刻意保留的例外：
//
//   - wiki-ingest.go 的目录树构建与向量补写：tree_node 只有那一个生产者，
//     搬过来只会多一层间接，不会消除重复；
//   - assistantsvc/document_write_tools.go 的移动文章：那是跨知识库改归属，
//     不属于「编译产物写入」这条链路，且与文章表的搬迁在同一个事务里。
package kb

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// wikiLinkInput 一条待写入的出链；LinkType 为空时按 related 落库。
type wikiLinkInput struct {
	ToPageKey string
	LinkType  string
}

// defaultWikiLinkType 与建表默认值保持一致。
const defaultWikiLinkType = "related"

func (l wikiLinkInput) linkType() string {
	if l.LinkType == "" {
		return defaultWikiLinkType
	}
	return l.LinkType
}

// wikiPageRef 删除页面时需要的最小标识：id 用于清派生数据，page_key 用于清入链。
type wikiPageRef struct {
	ID      int64
	PageKey string
}

func wikiPageRefsOf(pages []WikiPageRow) []wikiPageRef {
	refs := make([]wikiPageRef, 0, len(pages))
	for i := range pages {
		refs = append(refs, wikiPageRef{ID: pages[i].ID, PageKey: pages[i].PageKey})
	}
	return refs
}

type upsertWikiPageInput struct {
	UserID          int64
	KnowledgeBaseID int64
	PageKey         string
	Title           string
	Kind            string
	ContentMd       string
	Summary         *string
	Frontmatter     any // nil 表示 frontmatter_json 置 NULL
	HasFrontmatter  bool
	SourceRefs      []sourceRefInput
	Now             time.Time
}

type sourceRefInput struct {
	ArticleID int64
	Anchor    *string
	Note      *string
}

// upsertWikiPage 创建或递增版本更新页面，并整体替换来源引用。
func upsertWikiPage(ctx context.Context, q execQuerier, in upsertWikiPageInput) (*WikiPageRow, error) {
	normalizedPageKey := normalizePageKey(in.PageKey)
	contentHash := sha256Hex(in.ContentMd)
	existing, err := loadWikiPage(ctx, q, in.UserID, in.KnowledgeBaseID, normalizedPageKey)
	if err != nil {
		return nil, err
	}
	var frontmatterJSON *string
	if in.HasFrontmatter && in.Frontmatter != nil {
		frontmatterJSON = marshalJSON(in.Frontmatter)
	}
	var page *WikiPageRow
	if existing != nil {
		rows, uerr := q.Query(ctx,
			`UPDATE petrichor_kb_wiki_page SET title = $1, kind = $2, content_md = $3, summary = $4,
			 frontmatter_json = $5, content_hash = $6, archived_at = NULL, updated_at = $7, version = $8
			 WHERE id = $9 AND user_id = $10 RETURNING `+wikiPageColumns,
			in.Title, in.Kind, in.ContentMd, in.Summary, frontmatterJSON, contentHash, in.Now,
			existing.Version+1, existing.ID, in.UserID)
		if uerr != nil {
			return nil, uerr
		}
		page, uerr = scanSingleWikiPage(rows)
		if uerr != nil {
			return nil, uerr
		}
	} else {
		rows, ierr := q.Query(ctx,
			`INSERT INTO petrichor_kb_wiki_page (user_id, knowledge_base_id, page_key, title, kind,
			 content_md, summary, frontmatter_json, content_hash, version)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1) RETURNING `+wikiPageColumns,
			in.UserID, in.KnowledgeBaseID, normalizedPageKey, in.Title, in.Kind,
			in.ContentMd, in.Summary, frontmatterJSON, contentHash)
		if ierr != nil {
			return nil, ierr
		}
		page, ierr = scanSingleWikiPage(rows)
		if ierr != nil {
			return nil, ierr
		}
	}

	if err := replaceWikiSourceRefs(ctx, q, page.ID, in.SourceRefs); err != nil {
		return nil, err
	}
	return page, nil
}

func scanSingleWikiPage(rows pgx.Rows) (*WikiPageRow, error) {
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	return scanWikiPageRows(rows)
}

// logWikiEvent 记录 Wiki 审计事件。
func logWikiEvent(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64, eventType string, pageID *int64, payload any) error {
	payloadJSON := marshalJSON(payload)
	_, err := q.Exec(ctx,
		`INSERT INTO petrichor_kb_wiki_event_log (user_id, knowledge_base_id, event_type, page_id, payload_json)
		 VALUES ($1,$2,$3,$4,$5)`,
		userID, knowledgeBaseID, eventType, pageID, payloadJSON)
	return err
}

// deleteWikiPageByKey 物理删除单个页面及其派生数据；返回是否删除。
func deleteWikiPageByKey(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64, pageKey string) (bool, error) {
	page, err := loadWikiPage(ctx, q, userID, knowledgeBaseID, pageKey)
	if err != nil {
		return false, err
	}
	if page == nil {
		return false, nil
	}
	deleted, err := deleteWikiPagesCascade(ctx, q, userID, knowledgeBaseID,
		[]wikiPageRef{{ID: page.ID, PageKey: page.PageKey}})
	return deleted > 0, err
}

// ===== 出链 =====

// replaceWikiPageLinks 整体替换一个页面的出链：先清空再按序写入。
// 自链接与空 key 直接丢弃，避免把 lint 的 broken_link 规则喂成噪音。
func replaceWikiPageLinks(ctx context.Context, q execQuerier, page *WikiPageRow, links []wikiLinkInput) error {
	return replaceWikiPageLinksBatch(ctx, q, page.UserID, page.KnowledgeBaseID,
		[]int64{page.ID}, map[int64][]wikiLinkInput{page.ID: links},
		map[int64]string{page.ID: page.PageKey})
}

// replaceWikiPageLinksBatch 批量替换出链：一次 DELETE 清掉全部来源页的出链，再统一写入。
// pageKeys 用于剔除自链接；缺项的页面不做自链接过滤。
func replaceWikiPageLinksBatch(
	ctx context.Context,
	q execQuerier,
	userID, knowledgeBaseID int64,
	fromPageIDs []int64,
	linksByPage map[int64][]wikiLinkInput,
	pageKeys map[int64]string,
) error {
	if len(fromPageIDs) == 0 {
		return nil
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_link WHERE from_page_id = ANY($1)`, fromPageIDs); err != nil {
		return err
	}
	for _, fromPageID := range fromPageIDs {
		selfKey := pageKeys[fromPageID]
		for _, link := range linksByPage[fromPageID] {
			if link.ToPageKey == "" || link.ToPageKey == selfKey {
				continue
			}
			if _, err := q.Exec(ctx,
				`INSERT INTO petrichor_kb_wiki_link (user_id, knowledge_base_id, from_page_id, to_page_key, link_type)
				 VALUES ($1,$2,$3,$4,$5)`,
				userID, knowledgeBaseID, fromPageID, link.ToPageKey, link.linkType()); err != nil {
				return err
			}
		}
	}
	return nil
}

// ===== 来源引用 =====

// replaceWikiSourceRefs 整体替换一个页面的来源引用。
func replaceWikiSourceRefs(ctx context.Context, q execQuerier, pageID int64, refs []sourceRefInput) error {
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_source_ref WHERE page_id = $1`, pageID); err != nil {
		return err
	}
	for _, ref := range refs {
		if _, err := q.Exec(ctx,
			`INSERT INTO petrichor_kb_wiki_source_ref (page_id, article_id, anchor, quote_hash, note)
			 VALUES ($1, $2, $3, NULL, $4)`, pageID, ref.ArticleID, ref.Anchor, ref.Note); err != nil {
			return err
		}
	}
	return nil
}

// ===== 补丁 =====

// Wiki 补丁状态。
const (
	wikiPatchPending  = "PENDING"
	wikiPatchApplied  = "APPLIED"
	wikiPatchRejected = "REJECTED"
)

// setWikiPatchStatus 更新单个补丁的状态；置为 APPLIED 时一并写入生效时间。
func setWikiPatchStatus(ctx context.Context, q execQuerier, userID, patchID int64, status string, now time.Time) error {
	var appliedAt *time.Time
	if status == wikiPatchApplied {
		appliedAt = &now
	}
	_, err := q.Exec(ctx,
		`UPDATE petrichor_kb_wiki_patch SET status = $1, applied_at = COALESCE($2, applied_at), updated_at = $3
		 WHERE id = $4 AND user_id = $5`, status, appliedAt, now, patchID, userID)
	return err
}

// ===== 删除 =====

// deleteWikiPagesCascade 删除页面及其全部派生数据，顺序固定为
// 断开事件日志外键 → 清出链与入链 → 清来源引用 → 清目录树 → 删页面本身，
// 并把仍挂在这些页面上的待审补丁置为 REJECTED。返回实际删除的页面数。
func deleteWikiPagesCascade(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64, refs []wikiPageRef) (int, error) {
	if len(refs) == 0 {
		return 0, nil
	}
	pageIDs := make([]int64, 0, len(refs))
	pageKeys := make([]string, 0, len(refs))
	for _, ref := range refs {
		pageIDs = append(pageIDs, ref.ID)
		if ref.PageKey != "" {
			pageKeys = append(pageKeys, ref.PageKey)
		}
	}

	// 事件日志保留历史，只断开对将被删除页面的引用。
	if _, err := q.Exec(ctx,
		`UPDATE petrichor_kb_wiki_event_log SET page_id = NULL WHERE page_id = ANY($1)`, pageIDs); err != nil {
		return 0, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_link
		 WHERE user_id = $1 AND knowledge_base_id = $2
		   AND (from_page_id = ANY($3) OR to_page_key = ANY($4))`,
		userID, knowledgeBaseID, pageIDs, pageKeys); err != nil {
		return 0, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_source_ref WHERE page_id = ANY($1)`, pageIDs); err != nil {
		return 0, err
	}
	if _, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_tree_node WHERE page_id = ANY($1)`, pageIDs); err != nil {
		return 0, err
	}
	if len(pageKeys) > 0 {
		if _, err := q.Exec(ctx,
			`UPDATE petrichor_kb_wiki_patch SET status = $1, updated_at = $2
			 WHERE user_id = $3 AND knowledge_base_id = $4 AND page_key = ANY($5) AND status = $6`,
			wikiPatchRejected, time.Now(), userID, knowledgeBaseID, pageKeys, wikiPatchPending); err != nil {
			return 0, err
		}
	}
	tag, err := q.Exec(ctx,
		`DELETE FROM petrichor_kb_wiki_page
		 WHERE user_id = $1 AND knowledge_base_id = $2 AND id = ANY($3)`,
		userID, knowledgeBaseID, pageIDs)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}
