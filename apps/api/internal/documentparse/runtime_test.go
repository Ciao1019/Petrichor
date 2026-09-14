package documentparse

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 显式开启后只调用本机解析工具，不访问数据库、S3 或 OCR 服务。
// 可将 Linux 测试二进制挂载进最终 Worker 镜像运行，验证实际部署依赖。
func TestRuntimeOfflineDocuments(t *testing.T) {
	if os.Getenv("PETRICHOR_DOCUMENT_PARSE_RUNTIME_TEST") != "1" {
		t.Skip("需要显式开启离线解析运行时测试")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	cfg := DefaultConfig()
	if err := CheckRuntime(ctx, cfg); err != nil {
		t.Fatalf("解析运行时检查失败: %v", err)
	}
	t.Run("direct_documents", func(t *testing.T) {
		for _, test := range []struct {
			name   string
			source []byte
			want   string
		}{
			{"notes.md", []byte("# 原文\n\n正文 **保持不变**。\n"), "# 原文\n\n正文 **保持不变**。\n"},
			{"table.csv", []byte("名称,数量\n茶,2\n咖啡,3\n"), "咖啡"},
			{"notes.rtf", []byte(`{\rtf1\ansi Hello \b world\b0\par second paragraph}`), "world"},
			{"notes.docx", runtimeDOCX(t), "Offline DOCX content"},
		} {
			t.Run(test.name, func(t *testing.T) {
				dir := t.TempDir()
				count := 0
				err := Prepare(ctx, cfg, test.name, test.source, dir, nil, func(page Page) error {
					count++
					if page.PageNo != 1 || page.Markdown == nil || page.ImagePath != "" || !strings.Contains(*page.Markdown, test.want) {
						t.Fatal("直接解析结果未保留预期正文")
					}
					return nil
				})
				if err != nil || count != 1 {
					t.Fatalf("直接解析失败: count=%d err=%v", count, err)
				}
				runtimeAssertClean(t, dir)
			})
		}
	})
	t.Run("mixed_pdf", func(t *testing.T) {
		dir := t.TempDir()
		var stages, imagePaths []string
		count := 0
		err := Prepare(ctx, cfg, "mixed.pdf", runtimeMixedPDF(), dir, func(stage string) {
			stages = append(stages, stage)
		}, func(page Page) error {
			count++
			if page.PageNo != count {
				t.Fatal("页面顺序错误")
			}
			switch page.PageNo {
			case 1:
				if page.Markdown == nil || !strings.Contains(*page.Markdown, "Offline document") || page.ImagePath != "" {
					t.Fatal("文字页必须直接解析")
				}
			case 2:
				if page.Markdown != nil || page.ImagePath == "" {
					t.Fatal("扫描页必须产出 OCR 图片")
				}
				if err := validateImage(page.ImagePath); err != nil {
					t.Fatalf("实际渲染图片无效: %v", err)
				}
				imagePaths = append(imagePaths, page.ImagePath)
			case 3:
				if page.Markdown == nil || *page.Markdown != "" || page.ImagePath != "" {
					t.Fatal("结构性空白页必须直接成功且正文为空")
				}
			}
			return nil
		})
		if err != nil || count != 3 {
			t.Fatalf("混合 PDF 解析失败: count=%d err=%v", count, err)
		}
		renders := 0
		for _, stage := range stages {
			if stage == "rendering" {
				renders++
			}
		}
		if renders != 1 {
			t.Fatalf("仅扫描页应渲染，实际 %d 次", renders)
		}
		for _, path := range imagePaths {
			if _, err := os.Lstat(path); !os.IsNotExist(err) {
				t.Fatal("回调之后未删除临时图片")
			}
		}
		runtimeAssertClean(t, dir)
	})
	t.Run("encrypted_pdf", func(t *testing.T) {
		testRuntimeEncryptedPDF(t, ctx, cfg)
	})
	t.Run("damaged_pdf", func(t *testing.T) {
		err := Prepare(ctx, cfg, "damaged.pdf", []byte("%PDF-1.7\ndamaged"), t.TempDir(), nil, func(Page) error {
			t.Fatal("损坏 PDF 不应产生页面")
			return nil
		})
		if !IsPermanent(err) {
			t.Fatalf("损坏输入必须永久失败: %v", err)
		}
	})
}

func runtimeAssertClean(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("临时目录未清理: entries=%d err=%v", len(entries), err)
	}
}

func runtimeDOCX(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	for name, text := range map[string]string{
		"[Content_Types].xml": `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels":         `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml":   `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Offline DOCX content</w:t></w:r></w:p></w:body></w:document>`,
	} {
		part, err := writer.Create(filepath.ToSlash(name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(text)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// 使用最小合法 PDF 构造真实文字页、图片页和无 Contents/Annots 的空白页。
func runtimeMixedPDF() []byte {
	stream := func(dict, data string) string {
		return fmt.Sprintf("<< %s /Length %d >>\nstream\n%s\nendstream", dict, len(data), data)
	}
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 8 0 R >> >> /Contents 9 0 R >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		stream("", "BT /F1 12 Tf 72 700 Td (Offline document conversion preserves meaningful text. This is a complete text page with sufficient words for extraction.) Tj ET"),
		stream("/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8", strings.Repeat("\x7f", 64)),
		stream("", "q 500 0 0 700 50 50 cm /Im1 Do Q"),
	}
	var buf bytes.Buffer
	buf.WriteString("%PDF-1.5\n")
	offsets := []int{0}
	for i, object := range objects {
		offsets = append(offsets, buf.Len())
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, object)
	}
	xref := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&buf, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return buf.Bytes()
}
