package kb

import (
	"archive/zip"
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"

	"petrichor/api/internal/config"
)

// TestWikiExportBundleLive 是显式开启的只读集成测试：用本地 config.toml 的 PostgreSQL
// 挑一个已经编译出 Wiki 的知识库，验证 OKF bundle 能真实组装出来。
// 默认跳过，避免普通单测依赖开发者的数据库。
func TestWikiExportBundleLive(t *testing.T) {
	if os.Getenv("PETRICHOR_WIKI_EXPORT_LIVE_TEST") != "1" {
		t.Skip("设置 PETRICHOR_WIKI_EXPORT_LIVE_TEST=1 才运行真实导出测试")
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	q := pool()

	var userID, knowledgeBaseID int64
	var name string
	err := q.QueryRow(context.Background(), `
		SELECT k.user_id, k.id, k.name
		FROM petrichor_kb_knowledge_base k
		WHERE EXISTS (
			SELECT 1 FROM petrichor_kb_wiki_page p
			WHERE p.knowledge_base_id = k.id AND p.archived_at IS NULL
		)
		ORDER BY k.id ASC
		LIMIT 1`).Scan(&userID, &knowledgeBaseID, &name)
	if err != nil {
		t.Skipf("没有已编译 Wiki 的知识库可供导出：%v", err)
	}

	// lint 里新增的新鲜度判定要连真实数据一起跑通。
	pages, perr := loadWikiPageRows(context.Background(), q, userID, knowledgeBaseID)
	if perr != nil {
		t.Fatalf("加载 Wiki 页面失败：%v", perr)
	}
	lint, lerr := buildWikiLint(context.Background(), q, userID, knowledgeBaseID, pages)
	if lerr != nil {
		t.Fatalf("结构检查失败：%v", lerr)
	}
	stalePageCount, ok := lint["stalePageCount"].(int)
	if !ok {
		t.Fatalf("stalePageCount 类型异常：%#v", lint["stalePageCount"])
	}
	t.Logf("lint 得分 %v，问题 %v 个，待重编译 %d 页", lint["score"], lint["issueCount"], stalePageCount)

	for _, format := range []string{OKFFormatOKF, OKFFormatObsidian} {
		files, berr := buildOKFBundle(context.Background(), q, userID, &KBRow{ID: knowledgeBaseID, Name: name}, format)
		if berr != nil {
			t.Fatalf("format=%s 组装 bundle 失败：%v", format, berr)
		}
		archive, zerr := zipBundle(files)
		if zerr != nil {
			t.Fatalf("format=%s 打包失败：%v", format, zerr)
		}
		entries := readZipEntries(t, archive)
		if _, ok := entries["index.md"]; !ok {
			t.Fatalf("format=%s 缺少 index.md，实际条目：%v", format, entryNames(entries))
		}
		if _, ok := entries["log.md"]; !ok {
			t.Fatalf("format=%s 缺少 log.md，实际条目：%v", format, entryNames(entries))
		}
		for path, content := range entries {
			// log.md 是 OKF 保留的变更历史文件，规范不要求 frontmatter；
			// 其余文件都是概念文件，必须带上至少含 type 的 frontmatter。
			if path != "log.md" && !strings.HasPrefix(content, "---\n") {
				t.Fatalf("format=%s 的 %s 缺少 frontmatter", format, path)
			}
			if strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
				t.Fatalf("format=%s 出现越界路径：%s", format, path)
			}
		}
		if format == OKFFormatOKF {
			for path, content := range entries {
				if path != "log.md" && strings.Contains(content, "[[") {
					t.Fatalf("okf 格式仍残留未解析 wikilink：%s", path)
				}
			}
		}
		t.Logf("format=%s 导出 %d 个文件，%d 字节", format, len(files), len(archive))
	}
}

// TestWikiSkillPackLive 只读集成测试：验证知识库能真实蒸馏成 Skill 包。
func TestWikiSkillPackLive(t *testing.T) {
	if os.Getenv("PETRICHOR_WIKI_EXPORT_LIVE_TEST") != "1" {
		t.Skip("设置 PETRICHOR_WIKI_EXPORT_LIVE_TEST=1 才运行真实导出测试")
	}
	if _, err := config.Initialize(); err != nil {
		t.Fatal(err)
	}
	q := pool()

	var userID, knowledgeBaseID int64
	var name string
	var description *string
	err := q.QueryRow(context.Background(), `
		SELECT k.user_id, k.id, k.name, k.description
		FROM petrichor_kb_knowledge_base k
		WHERE EXISTS (
			SELECT 1 FROM petrichor_kb_wiki_page p
			WHERE p.knowledge_base_id = k.id AND p.archived_at IS NULL
		)
		ORDER BY k.id ASC
		LIMIT 1`).Scan(&userID, &knowledgeBaseID, &name, &description)
	if err != nil {
		t.Skipf("没有已编译 Wiki 的知识库：%v", err)
	}
	kbRow := &KBRow{ID: knowledgeBaseID, UserID: userID, Name: name, Description: description}

	files, slug, berr := buildKnowledgeSkillPack(context.Background(), q, userID, kbRow, false)
	if berr != nil {
		t.Fatalf("组装 Skill 包失败：%v", berr)
	}
	archive, zerr := zipBundle(files)
	if zerr != nil {
		t.Fatalf("打包失败：%v", zerr)
	}
	entries := readZipEntries(t, archive)

	manifest, ok := entries[slug+"/SKILL.md"]
	if !ok {
		t.Fatalf("缺少 SKILL.md，实际条目：%v", entryNames(entries))
	}
	if !strings.HasPrefix(manifest, "---\nname: "+slug+"\n") {
		t.Fatalf("SKILL.md frontmatter 不合规：%q", manifest[:80])
	}
	if _, ok := entries[slug+"/references/index.md"]; !ok {
		t.Fatalf("缺少 references/index.md，实际条目：%v", entryNames(entries))
	}
	for path := range entries {
		if !strings.HasPrefix(path, slug+"/") {
			t.Fatalf("包内出现顶层目录之外的文件：%s", path)
		}
	}
	t.Logf("Skill 包 %s：%d 个文件，%d 字节", slug, len(files), len(archive))
}

func readZipEntries(t *testing.T, archive []byte) map[string]string {
	t.Helper()
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("读取 zip 失败：%v", err)
	}
	out := map[string]string{}
	for _, file := range reader.File {
		handle, oerr := file.Open()
		if oerr != nil {
			t.Fatalf("打开 %s 失败：%v", file.Name, oerr)
		}
		content, rerr := io.ReadAll(handle)
		handle.Close()
		if rerr != nil {
			t.Fatalf("读取 %s 失败：%v", file.Name, rerr)
		}
		out[file.Name] = string(content)
	}
	return out
}

func entryNames(entries map[string]string) []string {
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	return names
}
