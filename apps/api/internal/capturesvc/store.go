// Package capturesvc 为随笔与 Agent 提供统一的网页采集任务服务。
package capturesvc

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
	"petrichor/api/internal/webcapture"
)

type Job struct {
	ID         string             `json:"id"`
	URL        string             `json:"url"`
	Options    webcapture.Options `json:"options"`
	State      string             `json:"state"`
	Title      string             `json:"title"`
	Error      string             `json:"error"`
	PreviousID *string            `json:"previousId"`
	CreatedAt  time.Time          `json:"createdAt"`
	UpdatedAt  time.Time          `json:"updatedAt"`
	Saved      bool               `json:"saved"`
	Result     *webcapture.Result `json:"result,omitempty"`
	UserID     int64              `json:"-"`
	Attempt    int                `json:"-"`
}
type CreateInput struct {
	URLs       []string           `json:"urls"`
	ClientID   string             `json:"clientId"`
	Options    webcapture.Options `json:"options"`
	PreviousID string             `json:"previousId"`
}

var clientPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{8,80}$`)

const columns = `j.id,j.user_id,j.url,j.options,j.state,j.title,j.error,j.previous_id,j.created_at,j.updated_at,j.attempt,EXISTS(SELECT 1 FROM petrichor_inbox_capture_source s WHERE s.capture_id=j.id AND (s.note_id IS NOT NULL OR s.article_id IS NOT NULL))`

func scan(row pgx.Row, withResult bool) (*Job, error) {
	j := &Job{}
	var options, result []byte
	args := []any{&j.ID, &j.UserID, &j.URL, &options, &j.State, &j.Title, &j.Error, &j.PreviousID, &j.CreatedAt, &j.UpdatedAt, &j.Attempt, &j.Saved}
	if withResult {
		args = append(args, &result)
	}
	if e := row.Scan(args...); e != nil {
		return nil, e
	}
	if e := json.Unmarshal(options, &j.Options); e != nil {
		return nil, e
	}
	if len(result) > 0 {
		if e := json.Unmarshal(result, &j.Result); e != nil {
			return nil, e
		}
	}
	return j, nil
}
func Get(ctx context.Context, userID int64, id string) (*Job, error) {
	j, e := scan(db.Pool().QueryRow(ctx, `SELECT `+columns+`,j.result FROM petrichor_inbox_capture j WHERE j.user_id=$1 AND j.id=$2 AND j.deleted_at IS NULL`, userID, id), true)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, httpx.NotFound("采集任务不存在")
	}
	return j, e
}

// 创建与额度检查在用户级事务锁内完成；数据库持久化即为队列 outbox。
func Create(ctx context.Context, userID int64, in CreateInput) ([]*Job, error) {
	cfg := config.Get().Firecrawl
	if !cfg.Enabled {
		return nil, httpx.BadRequest("网页采集尚未启用，请管理员配置 Firecrawl")
	}
	if !clientPattern.MatchString(in.ClientID) {
		return nil, httpx.BadRequest("采集请求标识无效")
	}
	if len(in.URLs) < 1 || len(in.URLs) > cfg.MaxBatch {
		return nil, httpx.BadRequest("网址数量超过本次采集上限")
	}
	if e := in.Options.Validate(cfg); e != nil {
		return nil, e
	}
	urls := []string{}
	seen := map[string]bool{}
	for _, raw := range in.URLs {
		u, e := webcapture.ValidateURL(ctx, raw)
		if e != nil {
			return nil, httpx.BadRequest(e.Error())
		}
		if !seen[u.String()] {
			urls = append(urls, u.String())
			seen[u.String()] = true
		}
	}
	if in.PreviousID != "" {
		if len(urls) != 1 {
			return nil, httpx.BadRequest("检查更新仅支持一个来源")
		}
		old, e := Get(ctx, userID, in.PreviousID)
		if e != nil {
			return nil, e
		}
		if old.URL != urls[0] || old.Result == nil {
			return nil, httpx.BadRequest("更新来源不匹配")
		}
		in.Options.Fresh = true
	}
	opts, _ := json.Marshal(in.Options)
	tx, e := db.Pool().Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('capture:' || $1,0))`, strconv.FormatInt(userID, 10)); e != nil {
		return nil, e
	}
	var used int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_capture WHERE user_id=$1 AND created_at >= date_trunc('day',now())`, userID).Scan(&used); e != nil {
		return nil, e
	}
	ids := []string{}
	for index, u := range urls {
		client := in.ClientID + "-" + strconv.Itoa(index)
		var id, oldURL string
		var oldOpts []byte
		var oldPrevious *string
		var deleted bool
		e = tx.QueryRow(ctx, `SELECT id,url,options,previous_id,deleted_at IS NOT NULL FROM petrichor_inbox_capture WHERE user_id=$1 AND client_id=$2`, userID, client).Scan(&id, &oldURL, &oldOpts, &oldPrevious, &deleted)
		if e == nil {
			if deleted {
				return nil, httpx.Conflict("这次采集已删除，请重新发起采集")
			}
			var old webcapture.Options
			_ = json.Unmarshal(oldOpts, &old)
			canonical, _ := json.Marshal(old)
			prev := ""
			if oldPrevious != nil {
				prev = *oldPrevious
			}
			if oldURL != u || string(canonical) != string(opts) || prev != in.PreviousID {
				return nil, httpx.Conflict("上次请求已创建，请查看采集记录；修改参数后重新发起")
			}
			ids = append(ids, id)
			continue
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		if used >= cfg.DailyLimit {
			return nil, httpx.TooManyRequests("今日网页采集额度已用完")
		}
		id = uuid.NewString()
		_, e = tx.Exec(ctx, `INSERT INTO petrichor_inbox_capture(id,user_id,client_id,url,options,previous_id) VALUES($1,$2,$3,$4,$5,NULLIF($6,''))`, id, userID, client, u, string(opts), in.PreviousID)
		if e != nil {
			return nil, e
		}
		used++
		ids = append(ids, id)
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	out := []*Job{}
	for _, id := range ids {
		_ = taskqueue.EnqueueCapture(ctx, id)
		j, e := Get(ctx, userID, id)
		if e != nil {
			return nil, e
		}
		out = append(out, j)
	}
	return out, nil
}
func List(ctx context.Context, userID int64, page, size int) ([]*Job, int, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 50 {
		size = 20
	}
	var total int
	e := db.Pool().QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_capture WHERE user_id=$1 AND deleted_at IS NULL`, userID).Scan(&total)
	if e != nil {
		return nil, 0, e
	}
	rows, e := db.Pool().Query(ctx, `SELECT `+columns+` FROM petrichor_inbox_capture j WHERE j.user_id=$1 AND j.deleted_at IS NULL ORDER BY j.created_at DESC,j.id DESC LIMIT $2 OFFSET $3`, userID, size, (page-1)*size)
	if e != nil {
		return nil, 0, e
	}
	defer rows.Close()
	out := []*Job{}
	for rows.Next() {
		j, e := scan(rows, false)
		if e != nil {
			return nil, 0, e
		}
		out = append(out, j)
	}
	return out, total, rows.Err()
}
func Cancel(ctx context.Context, userID int64, id string) error {
	tag, e := db.Pool().Exec(ctx, `UPDATE petrichor_inbox_capture SET state='cancelled',error='已取消后续处理；已提交的远端采集可能仍计费',updated_at=now(),lease_until=NULL WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND state IN ('queued','scraping','processing')`, id, userID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return httpx.Conflict("任务已结束或不存在")
	}
	_ = taskqueue.CancelCapture(id)
	return nil
}
