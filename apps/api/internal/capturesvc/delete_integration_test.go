package capturesvc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"petrichor/api/internal/db"
	"petrichor/api/internal/kb"
)

// 由隔离数据库生命周期测试调用，不连接业务数据库。
func testCaptureDeletion(t *testing.T, ctx context.Context, saved *Job, noteID any) {
	t.Helper()
	if code, _ := captureRequest(DeleteHandler, 2, map[string]any{"id": saved.ID}); code != 404 {
		t.Fatalf("不能删除他人记录: %d", code)
	}
	if code, _ := captureRequest(DeleteHandler, 1, map[string]any{"id": saved.ID}); code != 409 {
		t.Fatalf("已保存来源应被保护: %d", code)
	}
	seed := func(state string) string {
		t.Helper()
		id := fmt.Sprintf("delete-test-%s-%d", state, time.Now().UnixNano())
		options, _ := json.Marshal(saved.Options)
		result, _ := json.Marshal(saved.Result)
		_, err := db.Pool().Exec(ctx, `INSERT INTO petrichor_inbox_capture(id,user_id,client_id,url,options,state,result,title,lease_until,attempt) VALUES($1,1,$1,$2,$3,$4,$5,'可丢弃的采集',now()+interval '2 minutes',1)`, id, saved.URL, string(options), state, string(result))
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	for _, state := range []string{"queued", "scraping", "processing", "ready", "partial", "failed", "cancelled"} {
		t.Run("删除_"+state, func(t *testing.T) {
			id := seed(state)
			var before int
			if err := db.Pool().QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_capture WHERE user_id=1`).Scan(&before); err != nil {
				t.Fatal(err)
			}
			if err := Delete(ctx, 1, id); err != nil {
				t.Fatal(err)
			}
			if err := Delete(ctx, 1, id); err != nil {
				t.Fatal("重复删除应幂等", err)
			}
			if _, err := Get(ctx, 1, id); err == nil {
				t.Fatal("删除后仍能读取")
			}
			rows, total, err := List(ctx, 1, 1, 50)
			if err != nil || total != len(rows) {
				t.Fatal("列表计数不一致", err)
			}
			for _, row := range rows {
				if row.ID == id {
					t.Fatal("列表仍返回已删除记录")
				}
			}
			var after int
			_ = db.Pool().QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_capture WHERE user_id=1`).Scan(&after)
			if before != after {
				t.Fatal("删除不应重置已消耗的任务额度")
			}
			if claimed, err := claim(ctx, id); err != nil || claimed != nil {
				t.Fatal("Worker 重新领取已删除任务", err)
			}
			if err := checkpoint(ctx, &Job{ID: id, Attempt: 1}, "ready", saved.Result, ""); !errors.Is(err, context.Canceled) {
				t.Fatal("迟到结果复活记录", err)
			}
			request := map[string]any{"clientId": "save-" + id, "contentMd": "已删除的来源", "captureIds": []string{id}}
			if code, _ := captureRequest(kb.CreateInboxNote, 1, request); code != 400 {
				t.Fatal("已删除来源仍能保存到随笔", code)
			}
		})
	}
	t.Run("保存与删除并发时保护来源", func(t *testing.T) {
		id := seed("ready")
		tx, err := db.Pool().Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		var locked string
		if err = tx.QueryRow(ctx, `SELECT id FROM petrichor_inbox_capture WHERE id=$1 FOR UPDATE`, id).Scan(&locked); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- Delete(ctx, 1, id) }()
		deadline := time.Now().Add(3 * time.Second)
		for {
			var blocked bool
			err = db.Pool().QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT deleted_at IS NOT NULL%')`).Scan(&blocked)
			if err != nil {
				t.Fatal(err)
			}
			if blocked {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("删除没有等待来源行锁")
			}
			time.Sleep(10 * time.Millisecond)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO petrichor_inbox_capture_source(user_id,capture_id,note_id) VALUES(1,$1,$2)`, id, fmt.Sprint(noteID)); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if err = <-done; err == nil {
			t.Fatal("删除覆盖了并发保存的来源")
		}
		if _, err = Get(ctx, 1, id); err != nil {
			t.Fatal("保存成功后来源不可访问", err)
		}
	})
}
