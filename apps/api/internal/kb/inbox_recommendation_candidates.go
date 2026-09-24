package kb

import (
	"context"
	"strconv"
	"strings"
)

type inboxBaseCandidate struct {
	ID          string
	Name        string
	Description string
}

type inboxFolderCandidate struct {
	ID   string
	Path string
}

// 候选只来自当前用户；限制数量与描述长度，避免把整个知识库送往外部服务。
func loadInboxRecommendationBases(ctx context.Context, q execQuerier, userID int64) ([]inboxBaseCandidate, bool, error) {
	rows, err := q.Query(ctx, `SELECT id,name,COALESCE(description,'') FROM petrichor_kb_knowledge_base
 WHERE user_id=$1 ORDER BY updated_at DESC,id DESC LIMIT 101`, userID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := []inboxBaseCandidate{}
	for rows.Next() {
		var id int64
		var item inboxBaseCandidate
		if err = rows.Scan(&id, &item.Name, &item.Description); err != nil {
			return nil, false, err
		}
		item.ID = strconv.FormatInt(id, 10)
		items = append(items, item)
	}
	limited := len(items) > 100
	if limited {
		items = items[:100]
	}
	return items, limited, rows.Err()
}

func loadInboxRecommendationTags(ctx context.Context, q execQuerier, userID int64) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT tag FROM (
 SELECT t.tag FROM petrichor_kb_article_tag t JOIN petrichor_kb_article a ON a.id=t.article_id WHERE a.user_id=$1
 UNION ALL SELECT unnest(tags) AS tag FROM petrichor_inbox_note WHERE user_id=$1
 ) all_tags WHERE tag<>'' AND char_length(tag)<=80 GROUP BY tag ORDER BY count(*) DESC,tag LIMIT 40`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []string{}
	for rows.Next() {
		var tag string
		if err = rows.Scan(&tag); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}

func loadInboxRecommendationFolders(ctx context.Context, q execQuerier, userID int64, baseID string) ([]inboxFolderCandidate, bool, error) {
	rows, err := q.Query(ctx, `WITH RECURSIVE folders AS (
 SELECT id,name::text AS path,1 AS depth FROM petrichor_kb_node
 WHERE user_id=$1 AND knowledge_base_id=$2 AND type='FOLDER' AND parent_id IS NULL
 UNION ALL SELECT n.id,f.path || ' / ' || n.name,f.depth+1 FROM petrichor_kb_node n
 JOIN folders f ON n.parent_id=f.id WHERE n.user_id=$1 AND n.knowledge_base_id=$2 AND n.type='FOLDER' AND f.depth<32
 ) SELECT id,path FROM folders ORDER BY path,id LIMIT 101`, userID, baseID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	folders := []inboxFolderCandidate{}
	for rows.Next() {
		var id int64
		var item inboxFolderCandidate
		if err = rows.Scan(&id, &item.Path); err != nil {
			return nil, false, err
		}
		item.ID = strconv.FormatInt(id, 10)
		folders = append(folders, item)
	}
	limited := len(folders) > 100
	if limited {
		folders = folders[:100]
	}
	return folders, limited, rows.Err()
}

func trimInboxRecommendationText(s string, limit int) string {
	runes := []rune(strings.TrimSpace(s))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "…"
}

// 显式提交文章标签时，只允许使用该用户已有的标签；原随笔快照保持不变。
func validateInboxArchiveTags(ctx context.Context, q execQuerier, userID int64, tags []string) error {
	if len(tags) == 0 {
		return nil
	}
	var count int
	err := q.QueryRow(ctx, `SELECT count(DISTINCT tag) FROM (
 SELECT t.tag FROM petrichor_kb_article_tag t JOIN petrichor_kb_article a ON a.id=t.article_id WHERE a.user_id=$1 AND t.tag=ANY($2)
 UNION ALL SELECT unnest(tags) AS tag FROM petrichor_inbox_note WHERE user_id=$1 AND tags && $2::text[]
 ) owned_tags WHERE tag=ANY($2)`, userID, tags).Scan(&count)
	if err != nil {
		return err
	}
	if count != len(tags) {
		return badReq("标签已变更，请使用已有标签或重新获取推荐")
	}
	return nil
}
