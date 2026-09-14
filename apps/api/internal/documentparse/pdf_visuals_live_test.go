package documentparse

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 可选本地样本验证：不联网、不访问数据库，输出复制到测试指定的目录供视觉检查。
func TestPDFVisualLive(t *testing.T) {
	input := os.Getenv("PETRICHOR_DOCUMENT_VISUAL_PDF")
	if input == "" {
		t.Skip("未指定本地 PDF 样本")
	}
	output := os.Getenv("PETRICHOR_DOCUMENT_VISUAL_OUTPUT")
	if output == "" {
		t.Fatal("必须指定样本输出目录")
	}
	if err := os.MkdirAll(output, 0700); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	pages, images := 0, 0
	err = Prepare(context.Background(), DefaultConfig(), filepath.Base(input), data, t.TempDir(), nil, func(page Page) error {
		pages++
		images += len(page.Assets)
		var lines []string
		if page.Markdown != nil {
			lines = append(lines, *page.Markdown)
		}
		for i, a := range page.Assets {
			data, err := os.ReadFile(a.ImagePath)
			if err != nil {
				return err
			}
			name := fmt.Sprintf("page-%d-image-%d.png", page.PageNo, i+1)
			if err := os.WriteFile(filepath.Join(output, name), data, 0600); err != nil {
				return err
			}
			lines = append(lines, fmt.Sprintf("%s anchor=%q bounds=%v", name, a.Anchor, a.Bounds))
		}
		return os.WriteFile(filepath.Join(output, fmt.Sprintf("page-%d.txt", page.PageNo)), []byte(strings.Join(lines, "\n")), 0600)
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("已解析 %d 页，保留 %d 张图片", pages, images)
}
