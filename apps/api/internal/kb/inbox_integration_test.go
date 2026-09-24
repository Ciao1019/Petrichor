package kb

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"petrichor/api/internal/auth"
	"petrichor/api/migrations"
)

// 显式指定隔离数据库才运行；创建独立临时库，不读取 config.toml，也不接触业务数据。
func inboxTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("PETRICHOR_INBOX_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("指定专用 PETRICHOR_INBOX_TEST_DATABASE_URL 运行随笔事务测试")
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ConnConfig.Database != "petrichor_inbox_test" || (cfg.ConnConfig.Host != "127.0.0.1" && cfg.ConnConfig.Host != "localhost") {
		t.Fatal("测试仅接受回环地址上的 petrichor_inbox_test 专用数据库")
	}
	ctx := context.Background()
	admin, err := pgx.ConnectConfig(ctx, cfg.ConnConfig)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("petrichor_inbox_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+identifier); err != nil {
		admin.Close(ctx)
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+identifier+" WITH (FORCE)"); _ = admin.Close(ctx) })
	cfg.ConnConfig.Database = name
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	q, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(q.Close)
	entries, err := fs.Glob(migrations.Files, "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		sql, readErr := migrations.Files.ReadFile(entry)
		if readErr != nil {
			t.Fatal(readErr)
		}
		up := strings.Split(string(sql), "-- +goose Down")[0]
		if _, err = q.Exec(ctx, up, pgx.QueryExecModeSimpleProtocol); err != nil {
			t.Fatalf("迁移 %s: %v", entry, err)
		}
	}
	return q
}

func inboxRequest(handler gin.HandlerFunc, userID int64, body map[string]any) (int, map[string]any) {
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

func TestInboxDatabaseLifecycle(t *testing.T) {
	q := inboxTestPool(t)
	old := pool
	pool = func() *pgxpool.Pool { return q }
	t.Cleanup(func() { pool = old })
	gin.SetMode(gin.TestMode)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO petrichor_user(email,password_hash) VALUES ('one@test.invalid','unused'),('two@test.invalid','unused')`,
		`INSERT INTO petrichor_kb_knowledge_base(user_id,name) VALUES (1,'我的知识库'),(2,'他人的知识库')`,
		`INSERT INTO petrichor_kb_node(user_id,knowledge_base_id,type,name) VALUES (1,1,'FOLDER','我的文件夹'),(2,2,'FOLDER','其他文件夹')`,
	} {
		if _, err := q.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	request := map[string]any{"clientId": "test-create-request", "contentMd": "**想法** 100%\n\n第二段", "tags": []string{"灵感"}}
	code, note := inboxRequest(CreateInboxNote, 1, request)
	if code != 200 {
		t.Fatal(code, note)
	}
	code, duplicate := inboxRequest(CreateInboxNote, 1, request)
	if code != 200 || note["id"] != duplicate["id"] {
		t.Fatal("重复提交创建了多条记录", duplicate)
	}
	request["contentMd"] = "回复丢失后又修改的内容"
	if code, _ = inboxRequest(CreateInboxNote, 1, request); code != 409 {
		t.Fatal("不得吞掉重试时变更的内容", code)
	}
	for _, query := range []string{"100%", "%"} {
		code, list := inboxRequest(ListInboxNotes, 1, map[string]any{"keyword": query})
		if code != 200 || list["total"] != float64(1) {
			t.Fatal(code, list)
		}
	}
	code, list := inboxRequest(ListInboxNotes, 2, map[string]any{})
	if code != 200 || list["total"] != float64(0) {
		t.Fatal("随笔泄漏给其他用户", code, list)
	}
	richContent := `[{"type":"p","children":[{"text":"编辑后的内容","color":"red","underline":true}]}]`
	richMeta := `{"discussions":[],"users":{}}`
	edit := map[string]any{"contentJson": richContent, "contentMetaJson": richMeta, "id": note["id"], "version": float64(1), "contentMd": "编辑后的内容", "tags": []string{"灵感", "阅读"}}
	if code, _ = inboxRequest(UpdateInboxNote, 2, edit); code != 404 {
		t.Fatal("其他用户可编辑随笔", code)
	}
	code, note = inboxRequest(UpdateInboxNote, 1, edit)
	if code != 200 || note["version"] != float64(2) {
		t.Fatal(code, note)
	}
	if code, _ = inboxRequest(UpdateInboxNote, 1, edit); code != 409 {
		t.Fatal("旧版本覆盖了新内容", code)
	}
	archive := map[string]any{"id": note["id"], "version": float64(2), "knowledgeBaseId": "2", "parentId": nil, "title": "归档后的想法"}
	if code, _ = inboxRequest(ArchiveInboxNote, 1, archive); code != 404 {
		t.Fatal("可归档至其他用户知识库", code)
	}
	archive["knowledgeBaseId"] = "1"
	archive["parentId"] = "2"
	if code, _ = inboxRequest(ArchiveInboxNote, 1, archive); code != 404 {
		t.Fatal("可归档至其他用户文件夹", code)
	}
	archive["parentId"] = "1"
	results := make(chan map[string]any, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, data := inboxRequest(ArchiveInboxNote, 1, archive)
			data["status"] = status
			results <- data
		}()
	}
	wg.Wait()
	close(results)
	articleID := ""
	for result := range results {
		if result["status"] != 200 {
			t.Fatal(result)
		}
		id, _ := result["articleId"].(string)
		if id == "" || (articleID != "" && articleID != id) {
			t.Fatal("并发归档创建了重复文章", result)
		}
		articleID = id
	}
	var count int
	var content string
	if err := q.QueryRow(ctx, `SELECT count(*) FROM petrichor_kb_article`).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	if err := q.QueryRow(ctx, `SELECT content_md FROM petrichor_kb_article WHERE id=$1`, articleID).Scan(&content); err != nil || content != "编辑后的内容" {
		t.Fatal(content, err)
	}
	var storedJSON, storedMeta string
	if err := q.QueryRow(ctx, `SELECT content_json,content_meta_json FROM petrichor_kb_article WHERE id=$1`, articleID).Scan(&storedJSON, &storedMeta); err != nil {
		t.Fatal(err)
	}
	expectedJSON, expectedMeta, err := parseInboxRichContent(edit)
	if err != nil || !equalInboxJSON(&storedJSON, expectedJSON) || !equalInboxJSON(&storedMeta, expectedMeta) {
		t.Fatal("归档丢失富文本样式或批注", err)
	}
	if err := q.QueryRow(ctx, `SELECT count(*) FROM petrichor_kb_article_tag WHERE article_id=$1`, articleID).Scan(&count); err != nil || count != 2 {
		t.Fatal(count, err)
	}
	edit["version"] = float64(3)
	if code, _ = inboxRequest(UpdateInboxNote, 1, edit); code != 409 {
		t.Fatal("归档后仍可修改快照", code)
	}
	if code, _ = inboxRequest(DeleteInboxNote, 1, map[string]any{"id": note["id"], "version": float64(3)}); code != 200 {
		t.Fatal(code)
	}
	if err := q.QueryRow(ctx, `SELECT count(*) FROM petrichor_kb_article`).Scan(&count); err != nil || count != 1 {
		t.Fatal("删除归档记录误删文章", count, err)
	}

	// 在归档最后一步故意失败，验证先前插入的节点和文章不会残留。
	code, failed := inboxRequest(CreateInboxNote, 1, map[string]any{"clientId": "test-rollback-request", "contentMd": "模拟回滚", "tags": []string{}})
	if code != 200 {
		t.Fatal(code, failed)
	}
	_, err = q.Exec(ctx, `CREATE FUNCTION reject_test_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.archived_at IS NOT NULL THEN RAISE EXCEPTION 'test rollback'; END IF; RETURN NEW; END $$;
CREATE TRIGGER reject_test_archive BEFORE UPDATE ON petrichor_inbox_note FOR EACH ROW EXECUTE FUNCTION reject_test_archive();`, pgx.QueryExecModeSimpleProtocol)
	if err != nil {
		t.Fatal(err)
	}
	archive["id"], archive["version"] = failed["id"], float64(1)
	if code, _ = inboxRequest(ArchiveInboxNote, 1, archive); code != 500 {
		t.Fatal("预期模拟失败", code)
	}
	if err = q.QueryRow(ctx, `SELECT count(*) FROM petrichor_kb_article`).Scan(&count); err != nil || count != 1 {
		t.Fatal("归档失败残留文章", count, err)
	}
	if err = q.QueryRow(ctx, `SELECT count(*) FROM petrichor_kb_node WHERE type='ARTICLE'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("归档失败残留目录节点", count, err)
	}
	if err = q.QueryRow(ctx, `SELECT count(*) FROM petrichor_inbox_note WHERE archived_at IS NULL`).Scan(&count); err != nil || count != 1 {
		t.Fatal("归档失败丢失原文", count, err)
	}
	// 随笔图片必须纳入现有附件引用检查，避免知识库清理误删。
	_, err = q.Exec(ctx, `INSERT INTO petrichor_inbox_note(user_id,client_id,content_md,content_json) VALUES (1,'test-image-reference','附件', '[{"type":"file","url":"s4key:uploads/1/kept.png","children":[{"text":""}]}]')`)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := loadReferencedS4ObjectKeys(ctx, q, 1, []string{"uploads/1/kept.png"})
	if err != nil || len(keys) != 1 {
		t.Fatal("随笔图片未受到引用保护", keys, err)
	}
}
