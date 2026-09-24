package kb

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/httpx"
)

// 随笔只在当前用户范围内读写；归档后的内容保留为收集时的快照。
type inboxNote struct {
	archivedNow       bool // 仅当前事务新归档时置位，避免幂等重试重复记录采纳情况。
	Sources           json.RawMessage
	ID                int64
	ContentMd         string
	ContentJSON       *string
	ContentMetaJSON   *string
	Tags              []string
	Pinned            bool
	Version           int64
	ArchivedAt        *time.Time
	ArticleID         *int64
	KnowledgeBaseID   *int64
	KnowledgeBaseName *string
	ArticleTitle      *string
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

const inboxColumns = `n.id, n.content_md, n.tags, n.is_pinned, n.version,
 n.archived_at, a.id, a.knowledge_base_id, k.name, a.title, n.created_at, n.updated_at, n.content_json, n.content_meta_json,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'url',c.url,'title',c.title,'createdAt',c.created_at) ORDER BY c.created_at)
 FROM petrichor_inbox_capture_source s JOIN petrichor_inbox_capture c ON c.id=s.capture_id AND c.user_id=s.user_id
 WHERE s.note_id=n.id AND s.user_id=n.user_id),'[]'::jsonb)`
const inboxJoins = ` FROM petrichor_inbox_note n
 LEFT JOIN petrichor_kb_article a ON a.id = n.archived_article_id AND a.user_id = n.user_id
 LEFT JOIN petrichor_kb_knowledge_base k ON k.id = a.knowledge_base_id AND k.user_id = n.user_id`

func scanInboxNote(row pgx.Row) (*inboxNote, error) {
	n := &inboxNote{}
	err := row.Scan(&n.ID, &n.ContentMd, &n.Tags, &n.Pinned, &n.Version, &n.ArchivedAt,
		&n.ArticleID, &n.KnowledgeBaseID, &n.KnowledgeBaseName, &n.ArticleTitle, &n.CreatedAt, &n.UpdatedAt, &n.ContentJSON, &n.ContentMetaJSON, &n.Sources)
	return n, err
}

func (n *inboxNote) response() map[string]any {
	return map[string]any{
		"sources": n.Sources, "id": strconv.FormatInt(n.ID, 10), "contentMd": n.ContentMd, "tags": n.Tags,
		"contentJson": n.ContentJSON, "contentMetaJson": n.ContentMetaJSON,
		"pinned": n.Pinned, "version": n.Version, "archivedAt": isoPtr(n.ArchivedAt),
		"articleId": nullableIDString(n.ArticleID), "knowledgeBaseId": nullableIDString(n.KnowledgeBaseID),
		"knowledgeBaseName": n.KnowledgeBaseName, "articleTitle": n.ArticleTitle,
		"createdAt": iso(n.CreatedAt), "updatedAt": iso(n.UpdatedAt),
	}
}

func loadInboxNote(ctx context.Context, q execQuerier, userID, id int64, lock bool) (*inboxNote, error) {
	if lock {
		// 先锁主记录，再用新的语句快照关联文章。并发归档等待锁期间，
		// 单条 LEFT JOIN FOR UPDATE 可能读到新 archived_at 和旧的空文章关联。
		var lockedID int64
		err := q.QueryRow(ctx, `SELECT id FROM petrichor_inbox_note WHERE user_id=$1 AND id=$2 FOR UPDATE`, userID, id).Scan(&lockedID)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, httpx.NotFound("随笔不存在")
		}
		if err != nil {
			return nil, err
		}
	}
	query := `SELECT ` + inboxColumns + inboxJoins + ` WHERE n.user_id = $1 AND n.id = $2`
	n, err := scanInboxNote(q.QueryRow(ctx, query, userID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("随笔不存在")
	}
	return n, err
}

func parseInboxContent(raw map[string]any) (string, []string, error) {
	content, ok := raw["contentMd"].(string)
	content = strings.TrimSpace(content)
	if !ok || len([]rune(content)) == 0 || len([]rune(content)) > 20000 {
		return "", nil, badReq("随笔内容须为 1 到 20000 个字符")
	}
	values, ok := raw["tags"].([]any)
	if raw["tags"] != nil && !ok {
		return "", nil, badReq("标签必须是字符串数组")
	}
	for _, value := range values {
		if _, ok := value.(string); !ok {
			return "", nil, badReq("标签必须是字符串数组")
		}
	}
	tags, err := normalizeTags(values)
	return content, tags, err
}

var inboxClientIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{8,80}$`)

// CreateInboxNote 的 clientId 保证网络重试不会重复创建同一条随笔。
func CreateInboxNote(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		content, tags, err := parseInboxContent(raw)
		if err != nil {
			return nil, err
		}
		contentJSON, metaJSON, err := parseInboxRichContent(raw)
		if err != nil {
			return nil, err
		}
		clientID, _ := raw["clientId"].(string)
		if !inboxClientIDPattern.MatchString(clientID) {
			return nil, badReq("随笔请求标识无效")
		}
		userID, ctx := currentUser(c).ID, c.Request.Context()
		tx, err := pool().Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(context.WithoutCancel(ctx))
		var id int64
		var inserted bool
		err = tx.QueryRow(ctx, `INSERT INTO petrichor_inbox_note (user_id,client_id,content_md,tags,content_json,content_meta_json)
 VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id,client_id) DO UPDATE SET client_id = EXCLUDED.client_id
 RETURNING id,(xmax=0)`, userID, clientID, content, tags, contentJSON, metaJSON).Scan(&id, &inserted)
		if err != nil {
			return nil, err
		}
		n, err := loadInboxNote(ctx, tx, userID, id, false)
		if err != nil {
			return nil, err
		}
		if n.ContentMd != content || !slices.Equal(n.Tags, tags) || !equalInboxJSON(n.ContentJSON, contentJSON) || !equalInboxJSON(n.ContentMetaJSON, metaJSON) {
			return nil, httpx.Conflict("上一次记录已保存，请刷新查看；当前修改请保留后另行记录")
		}
		if !inserted && !sameInboxSources(n.Sources, raw["captureIds"]) {
			return nil, httpx.Conflict("上次记录已保存，但本次来源不同，请另建随笔")
		}
		if err = attachInboxSources(ctx, tx, userID, id, raw["captureIds"]); err != nil {
			return nil, err
		}
		n, err = loadInboxNote(ctx, tx, userID, id, false)
		if err != nil {
			return nil, err
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		return n.response(), nil
	})
}

func UpdateInboxNote(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		id, err := reqID(raw["id"], "随笔 ID 无效")
		if err != nil {
			return nil, err
		}
		version, err := reqID(raw["version"], "随笔版本无效")
		if err != nil {
			return nil, err
		}
		content, tags, err := parseInboxContent(raw)
		if err != nil {
			return nil, err
		}
		contentJSON, metaJSON, err := parseInboxRichContent(raw)
		if err != nil {
			return nil, err
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		tx, err := pool().Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(context.WithoutCancel(ctx))
		n, err := loadInboxNote(ctx, tx, userID, id, true)
		if err != nil {
			return nil, err
		}
		if n.ArchivedAt != nil {
			return nil, httpx.Conflict("随笔已归档，请到知识库编辑文章")
		}
		if n.Version != version {
			return nil, httpx.Conflict("随笔已在其他窗口修改，请保留当前内容并刷新列表")
		}
		_, err = tx.Exec(ctx, `UPDATE petrichor_inbox_note SET content_md=$1,tags=$2,content_json=$5,content_meta_json=$6,version=version+1,updated_at=now() WHERE id=$3 AND user_id=$4`, content, tags, id, userID, contentJSON, metaJSON)
		if err != nil {
			return nil, err
		}
		next, err := loadInboxNote(ctx, tx, userID, id, false)
		if err != nil {
			return nil, err
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		previousKeys := ExtractS4ObjectKeysFromArticleContent(n.ContentJSON, n.ContentMd, userID)
		nextKeys := ExtractS4ObjectKeysFromArticleContent(contentJSON, content, userID)
		ScheduleUnreferencedS4Cleanup(userID, RemovedS4ObjectKeys(previousKeys, nextKeys), "updateInboxNote")
		return next.response(), nil
	})
}

func PinInboxNote(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		id, err := reqID(raw["id"], "随笔 ID 无效")
		if err != nil {
			return nil, err
		}
		pinned, ok := raw["pinned"].(bool)
		if !ok {
			return nil, badReq("置顶状态无效")
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		result, err := pool().Exec(ctx, `UPDATE petrichor_inbox_note SET is_pinned=$1 WHERE id=$2 AND user_id=$3`, pinned, id, userID)
		if err != nil {
			return nil, err
		}
		if result.RowsAffected() == 0 {
			return nil, httpx.NotFound("随笔不存在")
		}
		return map[string]any{"success": true}, nil
	})
}

func DeleteInboxNote(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		id, err := reqID(raw["id"], "随笔 ID 无效")
		if err != nil {
			return nil, err
		}
		version, err := reqID(raw["version"], "随笔版本无效")
		if err != nil {
			return nil, err
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		var content string
		var contentJSON *string
		err = pool().QueryRow(ctx, `DELETE FROM petrichor_inbox_note WHERE id=$1 AND user_id=$2 AND version=$3 RETURNING content_md,content_json`, id, userID, version).Scan(&content, &contentJSON)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, httpx.Conflict("随笔已变更或不存在，请刷新后重试")
		}
		if err != nil {
			return nil, err
		}
		ScheduleUnreferencedS4Cleanup(userID, ExtractS4ObjectKeysFromArticleContent(contentJSON, content, userID), "deleteInboxNote")
		return map[string]any{"success": true}, nil
	})
}
