package capturesvc

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"petrichor/api/internal/auth"
	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/internal/dbmigrate"
	"petrichor/api/internal/kb"
	"petrichor/api/internal/webcapture"
)

// 仅连接显式指定的回环测试库，再创建隔离子库；不会读取用户的 config.toml。
func TestCaptureDatabaseLifecycle(t *testing.T) {
	dsn := os.Getenv("PETRICHOR_CAPTURE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("设置专用回环测试库以运行采集事务验收")
	}
	cfg, e := pgx.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	if cfg.Database != "petrichor_inbox_test" || (cfg.Host != "127.0.0.1" && cfg.Host != "localhost") {
		t.Fatal("仅允许回环 petrichor_inbox_test 隔离数据库")
	}
	ctx := context.Background()
	admin, e := pgx.ConnectConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	name := fmt.Sprintf("capture_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{name}.Sanitize()
	if _, e = admin.Exec(ctx, "CREATE DATABASE "+identifier); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		db.Close()
		_, _ = admin.Exec(ctx, "DROP DATABASE "+identifier+" WITH (FORCE)")
		_ = admin.Close(ctx)
	})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		status := 200
		if strings.Contains(fmt.Sprint(body["url"]), "fail") {
			status = 403
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"markdown": "# 阅读材料\n\n" + strings.Repeat("这是可追溯的原文段落。\n", 30), "metadata": map[string]any{"statusCode": status, "title": "阅读材料"}}})
	}))
	defer server.Close()
	dir := t.TempDir()
	cwd, _ := os.Getwd()
	t.Cleanup(func() { _ = os.Chdir(cwd) })
	if e = os.Chdir(dir); e != nil {
		t.Fatal(e)
	}
	testDSN := strings.Replace(dsn, "/petrichor_inbox_test", "/"+name, 1)
	toml := fmt.Sprintf("[database]\nurl=%q\n[storage]\nlocal_directory=%q\n[firecrawl]\nenabled=true\nbase_url=%q\ndaily_limit=20\n", testDSN, filepath.Join(dir, "objects"), server.URL)
	if e = os.WriteFile(filepath.Join(dir, "config.toml"), []byte(toml), 0600); e != nil {
		t.Fatal(e)
	}
	app, e := config.Initialize()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = dbmigrate.Up(ctx, app); e != nil {
		t.Fatal(e)
	}
	if e = db.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = db.Pool().Exec(ctx, `INSERT INTO petrichor_user(email,password_hash) VALUES ('capture1@test.invalid','unused'),('capture2@test.invalid','unused')`); e != nil {
		t.Fatal(e)
	}
	input := CreateInput{URLs: []string{"https://93.184.216.34/article"}, ClientID: "test-capture-first", Options: webcapture.Options{Mode: "read", Engine: "none", MainContent: true}}
	jobs, e := Create(ctx, 1, input)
	if e != nil {
		t.Fatal(e)
	}
	job := jobs[0]
	replay, e := Create(ctx, 1, input)
	if e != nil || replay[0].ID != job.ID {
		t.Fatal("创建未保持幂等", e)
	}
	changed := input
	changed.URLs = []string{"https://93.184.216.34/other"}
	if _, e = Create(ctx, 1, changed); e == nil {
		t.Fatal("相同请求 ID 改变内容应冲突")
	}
	if _, e = Get(ctx, 2, job.ID); e == nil {
		t.Fatal("其他用户读取了私有采集")
	}
	if e = HandleTask(ctx, asynq.NewTask("test", []byte(job.ID))); e != nil {
		t.Fatal(e)
	}
	ready, e := Get(ctx, 1, job.ID)
	if e != nil || ready.State != "ready" || ready.Result.MarkdownKey == "" {
		t.Fatalf("未完成持久化: %+v %v", ready, e)
	}
	if e = HandleTask(ctx, asynq.NewTask("test", []byte(job.ID))); e != nil || calls.Load() != 1 {
		t.Fatal("重放任务重复调用收费抓取", e, calls.Load())
	}
	gin.SetMode(gin.TestMode)
	request := map[string]any{"clientId": "capture-save-001", "contentMd": "## 我的笔记\n\n正文", "tags": []string{"阅读"}, "captureIds": []string{job.ID}}
	code, note := captureRequest(kb.CreateInboxNote, 1, request)
	if code != 200 {
		t.Fatal(code, note)
	}
	code, again := captureRequest(kb.CreateInboxNote, 1, request)
	if code != 200 || again["id"] != note["id"] {
		t.Fatal("保存未保持幂等", code, again)
	}
	if len(note["sources"].([]any)) != 1 {
		t.Fatal("丢失来源关系")
	}
	code, _ = captureRequest(kb.CreateInboxNote, 2, request)
	if code != 400 {
		t.Fatal("跨用户关联来源未被拒绝", code)
	}
	var count int
	_ = db.Pool().QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_note WHERE user_id=2`).Scan(&count)
	if count != 0 {
		t.Fatal("失败事务留下随笔")
	}
	input.ClientID = "test-capture-cancel"
	jobs, e = Create(ctx, 1, input)
	if e != nil {
		t.Fatal(e)
	}
	if e = Cancel(ctx, 1, jobs[0].ID); e != nil {
		t.Fatal(e)
	}
	if e = HandleTask(ctx, asynq.NewTask("test", []byte(jobs[0].ID))); e != nil || calls.Load() != 1 {
		t.Fatal("取消后仍采集")
	}
	input.ClientID = "test-capture-failure"
	input.URLs = []string{"https://93.184.216.34/fail"}
	jobs, e = Create(ctx, 1, input)
	if e != nil {
		t.Fatal(e)
	}
	if e = HandleTask(ctx, asynq.NewTask("test", []byte(jobs[0].ID))); e != nil {
		t.Fatal(e)
	}
	failed, _ := Get(ctx, 1, jobs[0].ID)
	if failed.State != "failed" || failed.Result != nil {
		t.Fatal("错误页被保存为成功")
	}
	input.ClientID = "test-capture-crash"
	input.URLs = []string{"https://93.184.216.34/crash"}
	jobs, e = Create(ctx, 1, input)
	if e != nil {
		t.Fatal(e)
	}
	j, e := claim(ctx, jobs[0].ID)
	if e != nil || j == nil {
		t.Fatal(e)
	}
	_, _ = db.Pool().Exec(ctx, `UPDATE petrichor_inbox_capture SET lease_until=now()-interval '1 minute' WHERE id=$1`, j.ID)
	_ = HandleReconcile(ctx, nil)
	j, e = Get(ctx, 1, j.ID)
	if e != nil || j.State != "failed" {
		t.Fatal("未知上游状态不应自动重发", e)
	}
	input.ClientID = "test-capture-update"
	input.URLs = []string{job.URL}
	input.PreviousID = job.ID
	jobs, e = Create(ctx, 1, input)
	if e != nil {
		t.Fatal(e)
	}
	if e = HandleTask(ctx, asynq.NewTask("test", []byte(jobs[0].ID))); e != nil {
		t.Fatal(e)
	}
	update, _ := Get(ctx, 1, jobs[0].ID)
	if update.Result.Change != "unchanged" {
		t.Fatal("更新比较失效")
	}
	testCaptureDeletion(t, ctx, ready, note["id"])
}
func captureRequest(handler gin.HandlerFunc, userID int64, body map[string]any) (int, map[string]any) {
	raw, _ := json.Marshal(body)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/api/inbox/test", strings.NewReader(string(raw)))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set("petrichor.user", &auth.User{ID: userID})
	handler(c)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}
