package migrations

import (
	"io/fs"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestEmbeddedMigrations(t *testing.T) {
	entries, err := fs.Glob(Files, "*.sql")
	if err != nil {
		t.Fatalf("读取内嵌迁移失败: %v", err)
	}
	want := []string{
		"202608270002_init.sql",
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
	if !strings.Contains(sql, "admin@petrichor.local") {
		t.Fatal("初始化迁移缺少默认管理员账号")
	}
	const passwordHash = "$2y$10$k50nCm9frffjyGwbhOAli.cEZxAz4iy.JAoULnLrPb2SM5k67JPma"
	if !strings.Contains(sql, passwordHash) {
		t.Fatal("初始化迁移缺少默认管理员密码哈希")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte("Petrichor@2026")); err != nil {
		t.Fatalf("默认管理员密码哈希无效: %v", err)
	}
}
