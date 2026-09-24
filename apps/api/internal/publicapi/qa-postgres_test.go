package publicapi

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	"petrichor/api/migrations"
)

// 只接受专用空测试库，在子进程加载临时配置，绝不读取本机 config.toml。
func TestPublicQaPostgres(t *testing.T) {
	databaseURL := os.Getenv("PETRICHOR_PUBLIC_QA_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("需要独立空 PostgreSQL 数据库 publicqa_test")
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil || parsed.Path != "/publicqa_test" || parsed.RawQuery != "" {
		t.Fatal("仅接受专用 publicqa_test 数据库，不允许 URL 查询参数")
	}
	if os.Getenv("PETRICHOR_PUBLIC_QA_TEST_CHILD") != "1" {
		cmd := exec.Command(os.Args[0], "-test.run", "^TestPublicQaPostgres$", "-test.v")
		cmd.Env = append(os.Environ(), "PETRICHOR_PUBLIC_QA_TEST_CHILD=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("隔离测试失败: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	t.Chdir(t.TempDir())
	if err := os.WriteFile(filepath.Join("config.toml"), []byte(fmt.Sprintf("[server]\nenvironment = 'test'\n[database]\nurl = %q\n", databaseURL)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := db.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var tables int
	if err := pool().QueryRow(ctx, `SELECT count(*) FROM information_schema.tables WHERE table_schema='public'`).Scan(&tables); err != nil || tables != 0 {
		t.Fatal("测试库必须为空")
	}
	baseline, err := migrations.Files.ReadFile("202608270002_init.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool().Exec(ctx, strings.Split(string(baseline), "-- +goose Down")[0]); err != nil {
		t.Fatal(err)
	}
	fixtures := []string{
		`INSERT INTO petrichor_user(id,email,password_hash) OVERRIDING SYSTEM VALUE VALUES (1,'qa@example.test','test')`,
		`INSERT INTO petrichor_kb_knowledge_base(id,user_id,name) OVERRIDING SYSTEM VALUE VALUES (1,1,'一号库'),(2,1,'二号库')`,
		`INSERT INTO petrichor_kb_node(id,user_id,knowledge_base_id,type,name) OVERRIDING SYSTEM VALUE VALUES (1,1,1,'article','文章'),(2,1,1,'article','密码文章'),(3,1,2,'article','文章三')`,
		`INSERT INTO petrichor_kb_article(id,user_id,knowledge_base_id,node_id,title,content_md) OVERRIDING SYSTEM VALUE VALUES
		 (1,1,1,1,'公开文章','未建索引也能查询独特术语'),(2,1,1,2,'密码文章','保密内容'),(3,1,2,3,'二号文章','二号公开内容')`,
		`INSERT INTO petrichor_kb_article_share(user_id,article_id,share_code,password_hash) VALUES (1,1,'public-one',NULL),(1,2,'password-two','hash'),(1,3,'public-three',NULL)`,
		`INSERT INTO petrichor_kb_wiki_page(id,user_id,knowledge_base_id,page_key,title,kind,content_md,content_hash) OVERRIDING SYSTEM VALUE VALUES
		 (1,1,1,'source-1','公开来源','source','公开正文 [[private-page|隐藏页面]]','hash'),
		 (2,1,1,'private-page','混合来源','concept','不允许公开的混合内容','hash'),
		 (3,1,1,'same-key','同名一','concept','一号库正文','hash'),
		 (4,1,2,'same-key','同名二','concept','二号库正文','hash')`,
		`INSERT INTO petrichor_kb_wiki_source_ref(page_id,article_id) VALUES (1,1),(2,1),(2,2),(3,1),(4,3)`,
		`INSERT INTO petrichor_kb_wiki_tree_node(user_id,knowledge_base_id,page_id,article_id,node_key,title,content_md,content_hash) VALUES
		 (1,1,1,1,'public-node','公开章节','公开章节正文','hash'),(1,1,2,1,'mixed-node','混合章节','混合章节保密内容','hash')`,
		`INSERT INTO petrichor_kb_article_chunk(id,user_id,knowledge_base_id,article_id,chunk_key,"position",heading,content_md,content_hash) OVERRIDING SYSTEM VALUE VALUES
		 (10,1,1,1,'c-10',0,'概览','公开文章概览','h10'),(11,1,1,1,'c-11',1,'安装步骤','先执行 dry-run 预览再清理','h11'),
		 (12,1,1,2,'c-12',0,'保密章节','保密内容','h12')`,
	}
	for _, sql := range fixtures {
		if _, err := pool().Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	scope, err := loadPublicArticleScope(ctx)
	if err != nil || len(scope) != 2 || scope[2] != nil {
		t.Fatalf("公开文章范围错误: %v", err)
	}
	searchScope, err := loadPublicSearchScope(ctx)
	if err != nil {
		t.Fatal(err)
	}
	hits, err := lexicalPublicQaArticles(ctx, "独特术语", searchScope, 8)
	if err != nil || len(hits) != 1 || hits[0].articleID != 1 || !strings.Contains(hits[0].snippet, "独特术语") {
		t.Fatalf("未建索引文章无法检索: %+v %v", hits, err)
	}
	knowledge, err := LoadPublicKnowledgeScope(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := knowledge.ReadArticle(ctx, 2); err == nil {
		t.Fatal("密码文章被读取")
	}
	for node, allowed := range map[string]bool{"public-node": true, "mixed-node": false} {
		_, err := knowledge.ReadTreeNode(ctx, node, 1)
		if (err == nil) != allowed {
			t.Fatalf("目录边界错误: %s %v", node, err)
		}
	}
	// 分片读取只认公开文章：公开分片可读，密码文章的分片视为不存在。
	if chunk, err := knowledge.Chunk(ctx, 11); err != nil || chunk.Href != "/p/public-one" || !strings.Contains(chunk.Content, "dry-run") {
		t.Fatalf("公开分片读取错误: %+v %v", chunk, err)
	}
	if _, err := knowledge.Chunk(ctx, 12); err == nil {
		t.Fatal("密码文章分片被读取")
	}
	if chunks, err := knowledge.BestChunks(ctx, 1, "dry-run", 1); err != nil || len(chunks) != 1 || chunks[0].ChunkID != 11 {
		t.Fatalf("最相关分片挑选错误: %+v %v", chunks, err)
	}
	if _, err := knowledge.BestChunks(ctx, 2, "保密", 1); err == nil {
		t.Fatal("密码文章可被深读")
	}
	if _, nodes, err := knowledge.ArticleOutline(ctx, 1, 50); err != nil || len(nodes) != 2 || nodes[1].Title != "安装步骤" {
		t.Fatalf("公开目录错误: %+v %v", nodes, err)
	}
	detail, err := knowledge.ReadWikiPage(ctx, "same-key", 2)
	if err != nil || detail["contentMd"] != "二号库正文" {
		t.Fatalf("Wiki 同名页解析错误: %+v %v", detail, err)
	}
	if _, err := knowledge.ReadWikiPage(ctx, "private-page", 1); err == nil {
		t.Fatal("混合来源 Wiki 被读取")
	}
	// 撤销分享后实时失效：二号库不再有任何公开资料。
	if _, err := pool().Exec(ctx, `UPDATE petrichor_kb_article_share SET revoked_at=now() WHERE article_id=3`); err != nil {
		t.Fatal(err)
	}
	revoked, err := LoadPublicKnowledgeScope(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(revoked.KnowledgeBases()) != 0 {
		t.Fatal("撤销分享后知识库仍可作为提问范围")
	}
	if _, err := revoked.ReadWikiPage(ctx, "same-key", 2); err == nil {
		t.Fatal("撤销分享后 Wiki 仍可读取")
	}
}
