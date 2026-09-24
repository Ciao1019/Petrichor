package kb

import (
	"context"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/httpx"
)

type inboxArchiveInput struct {
	NoteID                int64
	Version               int64
	KnowledgeBaseID       int64
	ParentID              *int64
	Title                 string
	Tags                  *[]string
	RecommendationToken   string
	RecommendationApplied bool
}

func parseInboxArchive(raw map[string]any) (inboxArchiveInput, error) {
	var in inboxArchiveInput
	for key, dest := range map[string]*int64{"id": &in.NoteID, "version": &in.Version, "knowledgeBaseId": &in.KnowledgeBaseID} {
		n, err := reqID(raw[key], key+" 无效")
		if err != nil {
			return in, err
		}
		*dest = n
	}
	if value := raw["parentId"]; value != nil && value != "" {
		id, err := reqID(value, "文件夹 ID 无效")
		if err != nil {
			return in, err
		}
		in.ParentID = &id
	}
	title, ok := raw["title"].(string)
	in.Title = strings.TrimSpace(title)
	if !ok || len([]rune(in.Title)) == 0 || len([]rune(in.Title)) > 200 {
		return in, badReq("文章标题须为 1 到 200 个字符")
	}
	if value, present := raw["tags"]; present {
		values, ok := value.([]any)
		if !ok {
			return in, badReq("标签必须是字符串数组")
		}
		for _, item := range values {
			if _, ok := item.(string); !ok {
				return in, badReq("标签必须是字符串数组")
			}
		}
		tags, err := normalizeTags(values)
		if err != nil {
			return in, err
		}
		in.Tags = &tags
	}
	in.RecommendationToken, _ = raw["recommendationToken"].(string)
	in.RecommendationApplied, _ = raw["recommendationApplied"].(bool)
	return in, nil
}

func ArchiveInboxNote(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		in, err := parseInboxArchive(raw)
		if err != nil {
			return nil, err
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		tx, err := pool().Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback(context.WithoutCancel(ctx))
		n, err := archiveInboxNote(ctx, tx, userID, in)
		if err != nil {
			return nil, err
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		if n.archivedNow {
			logInboxRecommendationFeedback(userID, in, n)
		}
		return n.response(), nil
	})
}

// 行锁保证重复归档或并发请求只生成一篇文章；失败时文章和随笔状态一起回滚。
func archiveInboxNote(ctx context.Context, tx pgx.Tx, userID int64, in inboxArchiveInput) (*inboxNote, error) {
	n, err := loadInboxNote(ctx, tx, userID, in.NoteID, true)
	if err != nil {
		return nil, err
	}
	if n.ArchivedAt != nil {
		if n.ArticleID == nil {
			return nil, httpx.Conflict("归档文章已删除，随笔原文仍保留")
		}
		return n, nil
	}
	if n.Version != in.Version {
		return nil, httpx.Conflict("随笔已修改，请刷新后重新归档")
	}
	if _, err = assertKnowledgeBaseOwner(ctx, tx, userID, in.KnowledgeBaseID); err != nil {
		return nil, err
	}
	if _, err = assertFolderParent(ctx, tx, userID, in.KnowledgeBaseID, in.ParentID); err != nil {
		return nil, err
	}
	tags := n.Tags
	if in.Tags != nil {
		tags = *in.Tags
		if err = validateInboxArchiveTags(ctx, tx, userID, tags); err != nil {
			return nil, err
		}
	}
	sortOrder, err := nextSortOrder(ctx, tx, userID, in.KnowledgeBaseID, in.ParentID)
	if err != nil {
		return nil, err
	}
	var nodeID, articleID int64
	err = tx.QueryRow(ctx, `INSERT INTO petrichor_kb_node (user_id,knowledge_base_id,parent_id,type,name,sort_order) VALUES ($1,$2,$3,'ARTICLE',$4,$5) RETURNING id`, userID, in.KnowledgeBaseID, in.ParentID, in.Title, sortOrder).Scan(&nodeID)
	if err != nil {
		return nil, err
	}
	excerpt, minutes, toc, hash := buildPublicArticleMetadata(n.ContentMd)
	err = tx.QueryRow(ctx, `INSERT INTO petrichor_kb_article (user_id,knowledge_base_id,node_id,title,content_md,public_excerpt,reading_minutes,toc_json,public_content_hash,content_json,content_meta_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, userID, in.KnowledgeBaseID, nodeID, in.Title, n.ContentMd, excerpt, minutes, toc, hash, n.ContentJSON, n.ContentMetaJSON).Scan(&articleID)
	if err != nil {
		return nil, err
	}
	if err = replaceArticleTags(ctx, tx, articleID, tags); err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `UPDATE petrichor_inbox_note SET archived_at=now(),archived_article_id=$1,is_pinned=false,version=version+1,updated_at=now() WHERE id=$2 AND user_id=$3`, articleID, n.ID, userID)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE petrichor_inbox_capture_source SET article_id=$1 WHERE note_id=$2 AND user_id=$3`, articleID, n.ID, userID); err != nil {
		return nil, err
	}
	_, err = tx.Exec(ctx, `UPDATE petrichor_kb_knowledge_base SET updated_at=now() WHERE id=$1 AND user_id=$2`, in.KnowledgeBaseID, userID)
	if err != nil {
		return nil, err
	}
	archived, err := loadInboxNote(ctx, tx, userID, n.ID, false)
	if err != nil {
		return nil, err
	}
	archived.archivedNow = true
	return archived, nil
}
