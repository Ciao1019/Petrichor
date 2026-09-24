package kb

import (
	"fmt"
	"strings"

	"github.com/gin-gonic/gin"
)

type inboxListInput struct {
	Status  string
	Keyword string
	Tag     string
	Pinned  bool
	Page    int64
	Size    int64
}

func parseInboxList(raw map[string]any) (inboxListInput, error) {
	in := inboxListInput{Status: "inbox", Page: 1, Size: 20}
	if value, ok := raw["status"].(string); ok && value != "" {
		in.Status = value
	}
	if in.Status != "inbox" && in.Status != "archived" && in.Status != "all" {
		return in, badReq("随笔筛选状态无效")
	}
	in.Keyword = strings.TrimSpace(toStr(raw["keyword"]))
	in.Tag = strings.TrimSpace(toStr(raw["tag"]))
	in.Pinned, _ = raw["pinned"].(bool)
	if len([]rune(in.Keyword)) > 200 || len([]rune(in.Tag)) > 80 {
		return in, badReq("搜索条件过长")
	}
	for key, dest := range map[string]*int64{"pageNum": &in.Page, "pageSize": &in.Size} {
		if raw[key] == nil {
			continue
		}
		n, err := reqID(raw[key], "分页参数无效")
		if err != nil {
			return in, err
		}
		*dest = n
	}
	if in.Size > 50 {
		in.Size = 50
	}
	if in.Page > 1000000 {
		return in, badReq("页码超出范围")
	}
	return in, nil
}

// ListInboxNotes 对搜索和标签执行服务端分页，统计数量始终覆盖当前用户的全部随笔。
func ListInboxNotes(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		in, err := parseInboxList(raw)
		if err != nil {
			return nil, err
		}
		ctx, userID := c.Request.Context(), currentUser(c).ID
		q := pool()
		where := ` WHERE n.user_id=$1`
		args := []any{userID}
		if in.Status == "inbox" {
			where += ` AND n.archived_at IS NULL`
		}
		if in.Status == "archived" {
			where += ` AND n.archived_at IS NOT NULL`
		}
		if in.Pinned {
			where += ` AND n.is_pinned`
		}
		if in.Keyword != "" {
			// LIKE 特殊字符按原文搜索，不把用户输入当成模式。
			keyword := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(in.Keyword)
			args = append(args, "%"+keyword+"%")
			where += fmt.Sprintf(` AND n.content_md ILIKE $%d`, len(args))
		}
		if in.Tag != "" {
			args = append(args, in.Tag)
			where += fmt.Sprintf(` AND $%d = ANY(n.tags)`, len(args))
		}
		var total, inbox, archived int64
		if err = q.QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_note n`+where, args...).Scan(&total); err != nil {
			return nil, err
		}
		args = append(args, in.Size, (in.Page-1)*in.Size)
		rows, err := q.Query(ctx, `SELECT `+inboxColumns+inboxJoins+where+fmt.Sprintf(` ORDER BY n.is_pinned DESC,n.created_at DESC,n.id DESC LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
		if err != nil {
			return nil, err
		}
		items := []map[string]any{}
		for rows.Next() {
			n, scanErr := scanInboxNote(rows)
			if scanErr != nil {
				rows.Close()
				return nil, scanErr
			}
			items = append(items, n.response())
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			return nil, err
		}
		if err = q.QueryRow(ctx, `SELECT count(*) FILTER(WHERE archived_at IS NULL),count(*) FILTER(WHERE archived_at IS NOT NULL) FROM petrichor_inbox_note WHERE user_id=$1`, userID).Scan(&inbox, &archived); err != nil {
			return nil, err
		}
		tagRows, err := q.Query(ctx, `SELECT tag,count(*) FROM petrichor_inbox_note n CROSS JOIN LATERAL unnest(n.tags) AS tag WHERE n.user_id=$1 GROUP BY tag ORDER BY count(*) DESC,tag LIMIT 100`, userID)
		if err != nil {
			return nil, err
		}
		defer tagRows.Close()
		tags := []map[string]any{}
		for tagRows.Next() {
			var tag string
			var count int64
			if err = tagRows.Scan(&tag, &count); err != nil {
				return nil, err
			}
			tags = append(tags, map[string]any{"name": tag, "count": count})
		}
		if err = tagRows.Err(); err != nil {
			return nil, err
		}
		return map[string]any{"rows": items, "total": total, "pageNum": in.Page, "pageSize": in.Size,
			"summary": map[string]any{"inbox": inbox, "archived": archived, "total": inbox + archived}, "tags": tags}, nil
	})
}
