package capturesvc

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/aicore"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
	"petrichor/api/internal/webcapture"
)

func run(c *gin.Context, fn func() (any, error)) {
	v, e := fn()
	if e != nil {
		httpx.HandleError(c, e)
		return
	}
	httpx.OK(c, v)
}
func Config(c *gin.Context) {
	run(c, func() (any, error) {
		cfg := config.Get().Firecrawl
		uid := auth.CurrentUser(c).ID
		_, modelErr := aicore.ResolveModelForPurpose(c.Request.Context(), uid, aicore.PurposeChat, nil)
		var used int
		e := db.Pool().QueryRow(c.Request.Context(), `SELECT count(*) FROM petrichor_inbox_capture WHERE user_id=$1 AND created_at>=date_trunc('day',now())`, uid).Scan(&used)
		if e != nil {
			return nil, e
		}
		return gin.H{"enabled": cfg.Enabled, "screenshot": cfg.Screenshot, "actions": cfg.Actions, "aiFormats": cfg.AIFormats, "modelReady": modelErr == nil, "maxBatch": cfg.MaxBatch, "dailyLimit": cfg.DailyLimit, "used": used}, nil
	})
}
func CreateHandler(c *gin.Context) {
	run(c, func() (any, error) {
		var in CreateInput
		if e := httpx.ReadJSON(c, &in); e != nil {
			return nil, e
		}
		jobs, e := Create(c.Request.Context(), auth.CurrentUser(c).ID, in)
		return gin.H{"jobs": jobs}, e
	})
}
func ListHandler(c *gin.Context) {
	run(c, func() (any, error) {
		var in struct {
			PageNum  int `json:"pageNum"`
			PageSize int `json:"pageSize"`
		}
		if e := httpx.ReadJSON(c, &in); e != nil {
			return nil, e
		}
		rows, total, e := List(c.Request.Context(), auth.CurrentUser(c).ID, in.PageNum, in.PageSize)
		return gin.H{"rows": rows, "total": total}, e
	})
}
func ResultHandler(c *gin.Context) {
	run(c, func() (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if e := httpx.ReadJSON(c, &in); e != nil {
			return nil, e
		}
		j, e := Get(c.Request.Context(), auth.CurrentUser(c).ID, in.ID)
		if e != nil {
			return nil, e
		}
		signAssets(j)
		return j, nil
	})
}
func CancelHandler(c *gin.Context) {
	run(c, func() (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if e := httpx.ReadJSON(c, &in); e != nil {
			return nil, e
		}
		return gin.H{"success": true}, Cancel(c.Request.Context(), auth.CurrentUser(c).ID, in.ID)
	})
}

// 只重跑已有原文的整理，不调用 Firecrawl；新结果不覆盖任何历史快照。
func RegenerateHandler(c *gin.Context) {
	run(c, func() (any, error) {
		var in struct {
			ID       string `json:"id"`
			ClientID string `json:"clientId"`
		}
		if e := httpx.ReadJSON(c, &in); e != nil {
			return nil, e
		}
		return Regenerate(c.Request.Context(), auth.CurrentUser(c).ID, in.ID, in.ClientID)
	})
}
func Regenerate(ctx context.Context, uid int64, id, clientID string) (*Job, error) {
	if !clientPattern.MatchString(clientID) {
		return nil, httpx.BadRequest("请求标识无效")
	}
	old, e := Get(ctx, uid, id)
	if e != nil {
		return nil, e
	}
	if old.Result == nil || (old.State != "ready" && old.State != "partial") {
		return nil, httpx.BadRequest("该任务尚无可整理的原文")
	}
	if _, e = aicore.ResolveModelForPurpose(ctx, uid, aicore.PurposeChat, nil); e != nil {
		return nil, e
	}
	// 使用同一创建入口消耗任务额度与保留幂等性，但事务内预置原文，Worker 不重复抓取。
	tx, e := db.Pool().Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('capture:' || $1,0))`, strconv.FormatInt(uid, 10)); e != nil {
		return nil, e
	}
	var existing string
	var previous *string
	e = tx.QueryRow(ctx, `SELECT id,previous_id FROM petrichor_inbox_capture WHERE user_id=$1 AND client_id=$2`, uid, "regenerate-"+clientID).Scan(&existing, &previous)
	if e == nil {
		if previous == nil || *previous != id {
			return nil, httpx.Conflict("该请求标识已用于其他来源")
		}
		if e = tx.Commit(ctx); e != nil {
			return nil, e
		}
		return Get(ctx, uid, existing)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	var used int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_capture WHERE user_id=$1 AND created_at>=date_trunc('day',now())`, uid).Scan(&used); e != nil {
		return nil, e
	}
	if used >= config.Get().Firecrawl.DailyLimit {
		return nil, httpx.TooManyRequests("今日整理任务额度已用完")
	}
	old.Options.Engine = "model"
	old.Result.Warnings = []string{}
	old.Result.InputTokens = 0
	old.Result.OutputTokens = 0
	zero := float64(0)
	old.Result.Credits = &zero
	opts, _ := json.Marshal(old.Options)
	result, _ := json.Marshal(old.Result)
	newID := uuid.NewString()
	_, e = tx.Exec(ctx, `INSERT INTO petrichor_inbox_capture(id,user_id,client_id,url,options,result,title,previous_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, newID, uid, "regenerate-"+clientID, old.URL, string(opts), string(result), old.Title, old.ID)
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	_ = taskqueue.EnqueueCapture(ctx, newID)
	return Get(ctx, uid, newID)
}

// 在完整历史中查找当前用户同网址的最新可用快照，供输入阶段提示重复采集。
func LookupHandler(c *gin.Context) {
	run(c, func() (any, error) {
		var in struct {
			URLs []string `json:"urls"`
		}
		if e := httpx.ReadJSON(c, &in); e != nil {
			return nil, e
		}
		if len(in.URLs) > 50 {
			return nil, httpx.BadRequest("最多查询 50 个网址")
		}
		urls := []string{}
		for _, raw := range in.URLs {
			u, e := webcapture.ParseURL(raw)
			if e != nil {
				return nil, httpx.BadRequest(e.Error())
			}
			urls = append(urls, u.String())
		}
		rows, e := db.Pool().Query(c.Request.Context(), `SELECT DISTINCT ON(j.url) `+columns+` FROM petrichor_inbox_capture j WHERE j.user_id=$1 AND j.deleted_at IS NULL AND j.url=ANY($2::text[]) AND j.state IN ('ready','partial') ORDER BY j.url,j.created_at DESC`, auth.CurrentUser(c).ID, urls)
		if e != nil {
			return nil, e
		}
		defer rows.Close()
		out := []*Job{}
		for rows.Next() {
			j, e := scan(rows, false)
			if e != nil {
				return nil, e
			}
			out = append(out, j)
		}
		return gin.H{"rows": out}, rows.Err()
	})
}
