package docextract

import (
	"archive/zip"
	"bytes"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestSupportedFileType(t *testing.T) {
	for _, ok := range []string{"md", "markdown", "csv", "tsv", "xlsx", "xls", "docx"} {
		if !SupportedFileType(ok) {
			t.Fatalf("%s 应支持服务端解析", ok)
		}
	}
	// PDF 需要版面信息，不走这个包。
	for _, no := range []string{"pdf", "txt", ""} {
		if SupportedFileType(no) {
			t.Fatalf("%s 不应由该包解析", no)
		}
	}
}

func TestExtractMarkdown(t *testing.T) {
	result, err := Extract("md", []byte("# 标题\r\n\r\n正文。\r结束"))
	if err != nil {
		t.Fatal(err)
	}
	// CRLF/CR 必须归一，否则分块偏移会和原文对不上。
	if strings.ContainsAny(result.Text, "\r") {
		t.Fatalf("换行未归一：%q", result.Text)
	}
	if result.Text != "# 标题\n\n正文。\n结束" {
		t.Fatalf("正文不符：%q", result.Text)
	}
	if len(result.Segments) != 1 || result.Segments[0].StartOffset != 0 {
		t.Fatalf("Markdown 应有单个起点为 0 的分段：%+v", result.Segments)
	}
}

func TestExtractCSV(t *testing.T) {
	result, err := Extract("csv", []byte("编号,说明\n1,第一条\n2,第二条\n"))
	if err != nil {
		t.Fatal(err)
	}
	// 首行作为列名，后续行的单元格带上 "列名: " 前缀。
	if !strings.Contains(result.Text, "编号: 1 | 说明: 第一条") {
		t.Fatalf("列名前缀缺失：\n%s", result.Text)
	}
	if !strings.HasPrefix(result.Text, "# Sheet1") {
		t.Fatalf("应以工作表标题开头：\n%s", result.Text)
	}
}

func TestExtractCSVRaggedRows(t *testing.T) {
	// 列数不一致不应报错——真实导出的 CSV 经常这样。
	if _, err := Extract("csv", []byte("a,b,c\n1,2\n3,4,5,6\n")); err != nil {
		t.Fatalf("列数不一致不应失败：%v", err)
	}
}

func TestExtractXLSXMultipleSheets(t *testing.T) {
	file := excelize.NewFile()
	defer file.Close()
	_ = file.SetCellValue("Sheet1", "A1", "编号")
	_ = file.SetCellValue("Sheet1", "B1", "说明")
	_ = file.SetCellValue("Sheet1", "A2", "1")
	_ = file.SetCellValue("Sheet1", "B2", "第一条")
	if _, err := file.NewSheet("明细"); err != nil {
		t.Fatal(err)
	}
	_ = file.SetCellValue("明细", "A1", "项目")
	_ = file.SetCellValue("明细", "A2", "内容")

	var buf bytes.Buffer
	if err := file.Write(&buf); err != nil {
		t.Fatal(err)
	}
	result, err := Extract("xlsx", buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(result.Text, "# Sheet1") || !strings.Contains(result.Text, "# 明细") {
		t.Fatalf("两个工作表都应出现：\n%s", result.Text)
	}
	if len(result.Segments) != 2 {
		t.Fatalf("应有 2 个工作表分段，实际 %d", len(result.Segments))
	}
	// 第二个工作表的起点必须落在换页符之后，分片才能标对来源。
	runes := []rune(result.Text)
	if result.Segments[1].StartOffset <= 0 || result.Segments[1].StartOffset >= len(runes) {
		t.Fatalf("第二段起点越界：%d / %d", result.Segments[1].StartOffset, len(runes))
	}
	if got := string(runes[result.Segments[1].StartOffset:]); !strings.HasPrefix(got, "# 明细") {
		t.Fatalf("第二段起点未对齐工作表开头：%q", truncate(got, 40))
	}
}

func TestExtractDOCX(t *testing.T) {
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	entry, err := writer.Create("word/document.xml")
	if err != nil {
		t.Fatal(err)
	}
	const documentXML = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t>续写</w:t></w:r></w:p>
<w:p><w:r><w:t>   </w:t></w:r></w:p>
<w:p><w:r><w:t>第二段</w:t></w:r></w:p>
</w:body></w:document>`
	if _, err := entry.Write([]byte(documentXML)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	result, err := Extract("docx", buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	// 同一段落里的多个 run 要拼起来，空白段落丢弃。
	if result.Text != "第一段续写\n第二段" {
		t.Fatalf("正文不符：%q", result.Text)
	}
}

func TestExtractUnsupported(t *testing.T) {
	if _, err := Extract("pdf", []byte("x")); err == nil {
		t.Fatal("PDF 应返回错误，交给专门的通道处理")
	}
}

func TestExtractBrokenInput(t *testing.T) {
	if _, err := Extract("xlsx", []byte("not a workbook")); err == nil {
		t.Fatal("损坏的 Excel 应返回错误")
	}
	if _, err := Extract("docx", []byte("not a zip")); err == nil {
		t.Fatal("损坏的 Word 应返回错误")
	}
}

func truncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
