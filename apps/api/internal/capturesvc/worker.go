package capturesvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/internal/taskqueue"
	"petrichor/api/internal/webcapture"
)

func claim(ctx context.Context, id string) (*Job, error) {
	tx, e := db.Pool().Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var userID int64
	e = tx.QueryRow(ctx, `SELECT user_id FROM petrichor_inbox_capture WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&userID)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('capture:' || $1,0))`, strconv.FormatInt(userID, 10)); e != nil {
		return nil, e
	}
	var count int
	e = tx.QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_capture WHERE user_id=$1 AND deleted_at IS NULL AND state IN ('scraping','processing') AND lease_until>now()`, userID).Scan(&count)
	if e != nil {
		return nil, e
	}
	if count >= config.Get().Firecrawl.PerUserConcurrency {
		return nil, errors.New("等待当前用户的其他采集任务完成")
	}
	var updated string
	e = tx.QueryRow(ctx, `UPDATE petrichor_inbox_capture SET state=CASE WHEN result IS NULL THEN 'scraping' ELSE 'processing' END,attempt=attempt+1,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=$1 AND deleted_at IS NULL AND (state='queued' OR (state='processing' AND lease_until<now())) RETURNING id`, id).Scan(&updated)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	j, e := scan(tx.QueryRow(ctx, `SELECT `+columns+`,j.result FROM petrichor_inbox_capture j WHERE j.id=$1`, id), true)
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return j, nil
}
func checkpoint(ctx context.Context, j *Job, state string, result *webcapture.Result, message string) error {
	data, e := json.Marshal(result)
	if e != nil {
		return e
	}
	var payload any = string(data)
	if result == nil {
		payload = nil
	}
	title := j.Title
	if result != nil {
		title = result.Note.Title
	}
	tag, e := db.Pool().Exec(ctx, `UPDATE petrichor_inbox_capture SET state=$2,result=$3,error=$4,title=$5,updated_at=now(),lease_until=CASE WHEN $2='processing' THEN now()+interval '2 minutes' ELSE NULL END WHERE id=$1 AND deleted_at IS NULL AND attempt=$6 AND state IN ('scraping','processing')`, j.ID, state, payload, message, title, j.Attempt)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return context.Canceled
	}
	return nil
}
func HandleTask(parent context.Context, t *asynq.Task) error {
	j, e := claim(parent, string(t.Payload()))
	if e != nil || j == nil {
		return e
	}
	ctx, cancel := context.WithTimeout(parent, 18*time.Minute)
	defer cancel()
	// 心跳同时观察持久化取消状态；中止模型与下载，不假称可撤销远端计费。
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				tag, e := db.Pool().Exec(ctx, `UPDATE petrichor_inbox_capture SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND deleted_at IS NULL AND attempt=$2 AND state IN ('scraping','processing')`, j.ID, j.Attempt)
				if e != nil || tag.RowsAffected() == 0 {
					cancel()
					return
				}
			}
		}
	}()
	r := j.Result
	if r == nil {
		if !config.Get().Firecrawl.Enabled {
			return checkpoint(ctx, j, "failed", nil, "网页采集服务已停用，未发起上游请求")
		}
		r, e = (webcapture.Client{Config: config.Get().Firecrawl}).Scrape(ctx, j.URL, j.Options)
		if e != nil {
			end, c := context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
			defer c()
			return checkpoint(end, j, "failed", nil, e.Error())
		}
		// 先提交正文，进程中断后只继续整理，绝不自动重发收费抓取。
		if e = checkpoint(ctx, j, "processing", r, ""); e != nil {
			return e
		}
	}
	persistAssets(ctx, j, r)
	if j.Options.Engine == "model" {
		if e = generate(ctx, j.UserID, j.Options, r); e != nil {
			r.Warnings = append(r.Warnings, e.Error())
		}
	}
	if j.PreviousID != nil {
		old, err := Get(ctx, j.UserID, *j.PreviousID)
		if err == nil && old.Result != nil {
			r.Change = "changed"
			if old.Result.Hash == r.Hash {
				r.Change = "unchanged"
			}
			r.Diff = diff(old.Result.Markdown, r.Markdown)
		}
	}
	state := "ready"
	if len(r.Warnings) > 0 {
		state = "partial"
	}
	if ctx.Err() != nil {
		state = "partial"
		r.Warnings = append(r.Warnings, "处理被中断，已保留可用原文；可再次整理")
	}
	end, c := context.WithTimeout(context.WithoutCancel(parent), 10*time.Second)
	defer c()
	return checkpoint(end, j, state, r, "")
}
func HandleReconcile(ctx context.Context, _ *asynq.Task) error {
	// 未知上游执行状态不能自动重发收费请求；用户显式重试创建新的记录。
	_, e := db.Pool().Exec(ctx, `UPDATE petrichor_inbox_capture SET state='failed',error='采集进程中断，上游执行状态未知；可能已计费，请确认后重试',lease_until=NULL,updated_at=now() WHERE deleted_at IS NULL AND state='scraping' AND lease_until<now()`)
	if e != nil {
		return e
	}
	rows, e := db.Pool().Query(ctx, `SELECT id FROM petrichor_inbox_capture WHERE deleted_at IS NULL AND (state='queued' OR (state='processing' AND lease_until<now())) ORDER BY created_at LIMIT 200`)
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, id := range ids {
		if e = taskqueue.EnqueueCapture(ctx, id); e != nil {
			return e
		}
	}
	return nil
}

// 公共前后缀定位变更段，不执行上游返回的 diff 或 HTML。
func diff(old, new string) string {
	if old == new {
		return "内容未变化"
	}
	a, b := strings.Split(old, "\n"), strings.Split(new, "\n")
	start := 0
	for start < len(a) && start < len(b) && a[start] == b[start] {
		start++
	}
	endA, endB := len(a), len(b)
	for endA > start && endB > start && a[endA-1] == b[endB-1] {
		endA--
		endB--
	}
	out := []string{fmt.Sprintf("@@ 原文第 %d 行起 @@", start+1)}
	for _, s := range a[start:endA] {
		out = append(out, "- "+s)
	}
	for _, s := range b[start:endB] {
		out = append(out, "+ "+s)
	}
	text := strings.Join(out, "\n")
	if len([]rune(text)) > 40000 {
		return string([]rune(text)[:40000]) + "\n（差异过长，以上为节选；完整正文见原文页签）"
	}
	return text
}
