package assistantsvc

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	rt "petrichor/api/internal/assistantsvc/runtime"
	"petrichor/api/migrations"
)

// 仅接受专用临时库；不读取 config.toml。该测试会创建并清理隔离 schema。
func TestContinuationPostgres(t *testing.T) {
	url := os.Getenv("PETRICHOR_CONTINUATION_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("需要专用临时 PostgreSQL")
	}
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if _, err = admin.Exec(ctx, `CREATE SCHEMA continuation_test`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, `DROP SCHEMA continuation_test CASCADE`) }()
	cfg.ConnConfig.RuntimeParams["search_path"] = "continuation_test"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	before := continuationDB
	continuationDB = func() *pgxpool.Pool { return pool }
	defer func() { continuationDB = before }()
	for _, sql := range []string{`CREATE TABLE petrichor_user(id bigint PRIMARY KEY)`, `CREATE TABLE petrichor_assistant_thread(id bigint PRIMARY KEY)`, `INSERT INTO petrichor_user VALUES (1),(2)`, `INSERT INTO petrichor_assistant_thread VALUES (10)`} {
		if _, err = pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	migration, err := migrations.Files.ReadFile("202609220001_agent_continuation.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, strings.Split(string(migration), "-- +goose Down")[0]); err != nil {
		t.Fatal(err)
	}
	payload := continuationPayload{Goal: "继续整理", Messages: []json.RawMessage{json.RawMessage(`{"role":"user","parts":[{"type":"text","text":"继续整理"}]}`)}, ModelID: 1}
	lease, err := acquireContinuation(ctx, 1, 10, payload, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = acquireContinuation(ctx, 1, 10, payload, ""); err == nil {
		t.Fatal("同一任务重复获得租约")
	}
	state := rt.NewAgentStateStore(lease.runKey, "10", "1", payload.Goal, rt.ComplexitySimple, 1).Snapshot()
	state.ToolCallCount = 3
	if err = lease.save(ctx, state, nil); err != nil {
		t.Fatal(err)
	}
	lease.finish(ctx, false)
	if _, _, err = loadContinuation(ctx, 2, 10); err == nil {
		t.Fatal("跨用户读取了检查点")
	}
	restored, key, err := loadContinuation(ctx, 1, 10)
	if err != nil || restored.State.ToolCallCount != 3 {
		t.Fatalf("%+v %v", restored, err)
	}
	resumed, err := acquireContinuation(ctx, 1, 10, *restored, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = lease.save(ctx, state, nil); err == nil {
		t.Fatal("旧租约覆盖了新任务")
	}
	if lease.owns(ctx) || !resumed.owns(ctx) {
		t.Fatal("旧执行者仍可写入对话消息")
	}
	if _, err = pool.Exec(ctx, `UPDATE petrichor_agent_continuation SET controls_json='[{"sequence":1,"mode":"steer","text":"追加"}]'::jsonb WHERE thread_id=10`); err != nil {
		t.Fatal(err)
	}
	controls, err := resumed.controls(ctx, 0)
	if err != nil || len(controls) != 1 {
		t.Fatalf("%+v %v", controls, err)
	}
	resumed.finish(ctx, true)
	if _, _, err = loadContinuation(ctx, 1, 10); err != nil {
		t.Fatalf("未处理的补充要求丢失: %v", err)
	}
	restored, key, err = loadContinuation(ctx, 1, 10)
	if err != nil {
		t.Fatal(err)
	}
	resumed, err = acquireContinuation(ctx, 1, 10, *restored, key)
	if err != nil {
		t.Fatal(err)
	}
	if err = resumed.save(ctx, state, &rt.PendingTool{ID: "mcp.write", SideEffect: true}); err != nil {
		t.Fatal(err)
	}
	resumed.finish(ctx, false)
	if _, _, err = loadContinuation(ctx, 1, 10); err == nil {
		t.Fatal("允许自动重放未知结果的写操作")
	}
	newRun, err := acquireContinuation(ctx, 1, 10, payload, "")
	if err != nil {
		t.Fatal(err)
	}
	if err = newRun.save(ctx, state, nil); err != nil {
		t.Fatal(err)
	}
	newRun.finish(ctx, true)
	if _, _, err = loadContinuation(ctx, 1, 10); err == nil {
		t.Fatal("允许恢复已完成任务")
	}
}
