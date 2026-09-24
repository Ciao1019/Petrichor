package kb

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"petrichor/api/internal/httpx"
	"sort"
	"strings"
)

// 来源引用独立于富文本；归档后保留文章关联，删除随笔不会失去来源快照。
func attachInboxSources(ctx context.Context, tx pgx.Tx, userID, noteID int64, raw any) error {
	if raw == nil {
		return nil
	}
	items, ok := raw.([]any)
	if !ok || len(items) > 20 {
		return httpx.BadRequest("最多关联 20 个采集来源")
	}
	ids := make([]string, 0, len(items))
	for _, value := range items {
		id, ok := value.(string)
		if !ok || len(id) > 100 || strings.TrimSpace(id) == "" {
			return httpx.BadRequest("采集来源标识无效")
		}
		ids = append(ids, id)
	}
	// 固定加锁顺序，避免多条来源以不同顺序保存时发生死锁。
	sort.Strings(ids)
	for _, id := range ids {
		var lockedID string
		e := tx.QueryRow(ctx, `SELECT id FROM petrichor_inbox_capture WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND state IN ('ready','partial') AND result IS NOT NULL FOR UPDATE`, id, userID).Scan(&lockedID)
		if errors.Is(e, pgx.ErrNoRows) {
			return httpx.BadRequest("采集来源不存在、已删除、尚未完成或无权访问")
		}
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO petrichor_inbox_capture_source(user_id,capture_id,note_id) VALUES($1,$2,$3) ON CONFLICT(note_id,capture_id) DO NOTHING`, userID, id, noteID)
		if e != nil {
			return e
		}
	}
	return nil
}

func sameInboxSources(stored json.RawMessage, raw any) bool {
	var sources []struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(stored, &sources) != nil {
		return false
	}
	items := []any{}
	if raw != nil {
		var ok bool
		items, ok = raw.([]any)
		if !ok {
			return false
		}
	}
	desired := map[string]bool{}
	for _, item := range items {
		id, ok := item.(string)
		if !ok {
			return false
		}
		desired[id] = true
	}
	if len(sources) != len(desired) {
		return false
	}
	for _, source := range sources {
		if !desired[source.ID] {
			return false
		}
	}
	return true
}
