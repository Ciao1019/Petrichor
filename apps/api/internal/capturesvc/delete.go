package capturesvc

import (
	"context"
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/taskqueue"
)

func DeleteHandler(c *gin.Context) {
	run(c, func() (any, error) {
		var in struct {
			ID string `json:"id"`
		}
		if err := httpx.ReadJSON(c, &in); err != nil {
			return nil, err
		}
		return gin.H{"success": true}, Delete(c.Request.Context(), auth.CurrentUser(c).ID, in.ID)
	})
}

// Delete 与随笔保存共用来源行锁，防止删除与关联来源并发时留下不可访问的随笔引用。
// 保留行以维持当日额度和请求幂等性；原文附件可能被其他版本复用，不在这里清理。
func Delete(ctx context.Context, userID int64, id string) error {
	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))

	var deleted bool
	err = tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM petrichor_inbox_capture WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID).Scan(&deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound("采集记录不存在")
	}
	if err != nil {
		return err
	}
	if deleted {
		return tx.Commit(ctx)
	}
	var referenced bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM petrichor_inbox_capture_source WHERE capture_id=$1 AND (note_id IS NOT NULL OR article_id IS NOT NULL))`, id).Scan(&referenced)
	if err != nil {
		return err
	}
	if referenced {
		return httpx.Conflict("该来源已保存到随笔或文章，不能删除")
	}
	_, err = tx.Exec(ctx, `UPDATE petrichor_inbox_capture SET deleted_at=now(),updated_at=now(),lease_until=NULL,state=CASE WHEN state IN ('queued','scraping','processing') THEN 'cancelled' ELSE state END WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	_ = taskqueue.CancelCapture(id)
	return nil
}
