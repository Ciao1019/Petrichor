package migrations

import (
	"io/fs"
	"reflect"
	"strings"
	"testing"
)

func TestEmbeddedMigrations(t *testing.T) {
	entries, err := fs.Glob(Files, "*.sql")
	if err != nil {
		t.Fatalf("读取内嵌迁移失败: %v", err)
	}
	want := []string{
		"202608270002_init.sql",
		"202608280001_knowledge_build_job.sql",
		"202608280002_worker_retry_and_dead_letter.sql",
		"202608280003_drop_knowledge_build_job.sql",
	}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("内嵌迁移不符合预期\n实际: %v\n期望: %v", entries, want)
	}

	data, err := fs.ReadFile(Files, want[0])
	if err != nil {
		t.Fatalf("读取初始化迁移失败: %v", err)
	}
	sql := string(data)
	lowerSQL := strings.ToLower(sql)
	for _, forbidden := range []string{"\ndrop ", "\nupdate ", "\ndelete ", "\ntruncate "} {
		if strings.Contains(lowerSQL, forbidden) {
			t.Fatalf("初始化迁移包含历史清理或数据回填语句: %q", strings.TrimSpace(forbidden))
		}
	}
	for _, required := range []string{
		"CREATE TABLE public.petrichor_user",
		"CREATE TABLE public.sa_token_storage",
		"首次启动后由 /api/auth/setup",
	} {
		if !strings.Contains(sql, required) {
			t.Fatalf("初始化迁移缺少最终结构: %q", required)
		}
	}
	for _, forbidden := range []string{"better_auth", "auth_user_id", "petrichor_auth_session", "Petrichor@2026"} {
		if strings.Contains(sql, forbidden) {
			t.Fatalf("初始化迁移残留废弃认证对象: %q", forbidden)
		}
	}

	data, err = fs.ReadFile(Files, want[1])
	if err != nil {
		t.Fatalf("读取知识构建任务迁移失败: %v", err)
	}
	jobSQL := string(data)
	for _, required := range []string{
		"CREATE TABLE public.petrichor_kb_knowledge_build_job",
		"uq_petrichor_kb_knowledge_build_job_active",
		"FOREIGN KEY (article_id)",
	} {
		if !strings.Contains(jobSQL, required) {
			t.Fatalf("知识构建任务迁移缺少结构: %q", required)
		}
	}

	data, err = fs.ReadFile(Files, want[2])
	if err != nil {
		t.Fatalf("读取 Worker 重试迁移失败: %v", err)
	}
	retrySQL := string(data)
	for _, required := range []string{
		"attempt_count integer DEFAULT 0 NOT NULL",
		"next_attempt_at timestamp with time zone",
		"lease_expires_at timestamp with time zone",
		"dead_lettered_at timestamp with time zone",
		"idx_petrichor_kb_import_job_page_runnable",
	} {
		if !strings.Contains(retrySQL, required) {
			t.Fatalf("Worker 重试迁移缺少结构: %q", required)
		}
	}

	data, err = fs.ReadFile(Files, want[3])
	if err != nil {
		t.Fatalf("读取知识构建内存队列迁移失败: %v", err)
	}
	dropJobSQL := string(data)
	if !strings.Contains(dropJobSQL, "DROP TABLE public.petrichor_kb_knowledge_build_job") {
		t.Fatal("知识构建内存队列迁移没有删除旧任务表")
	}
}
