// Package docextract 在服务端把上传的文件解析成纯文本。
//
// 分块由 internal/chunker 负责，这里只解决"文件字节 → 正文"这一步，
// 并给出页 / 工作表边界，让分块结果能标注来源位置。
//
// 输出格式与浏览器端原有的解析保持一致（表格用 " | " 连接、非首行带列名前缀、
// 多工作表用换页符分隔），这样同一份文件从哪条路径进来，正文都是同一份。
package docextract

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"fmt"
	"io"
	"strings"

	"github.com/xuri/excelize/v2"
)

// Segment 描述正文里一段区间的归属，用来给分片补页码 / 工作表名。
type Segment struct {
	StartOffset int     `json:"startOffset"`
	Page        *int    `json:"page"`
	Locator     *string `json:"locator"`
}

// Result 是一次解析的产物。
type Result struct {
	Text      string
	Segments  []Segment
	PageCount *int
}

// SupportedFileType 判断某个类型能否在服务端解析。
func SupportedFileType(fileType string) bool {
	switch normalizeType(fileType) {
	case "md", "csv", "xlsx", "docx":
		return true
	default:
		return false
	}
}

func normalizeType(fileType string) string {
	switch strings.ToLower(strings.TrimSpace(fileType)) {
	case "md", "markdown":
		return "md"
	case "csv", "tsv":
		return "csv"
	case "xlsx", "xls":
		return "xlsx"
	case "docx":
		return "docx"
	case "pdf":
		return "pdf"
	default:
		return ""
	}
}

// Extract 按文件类型解析出正文。PDF 不在这里处理（需要版面信息，走单独的通道）。
func Extract(fileType string, data []byte) (*Result, error) {
	switch normalizeType(fileType) {
	case "md":
		return extractMarkdown(data), nil
	case "csv":
		return extractCSV(data)
	case "xlsx":
		return extractXLSX(data)
	case "docx":
		return extractDOCX(data)
	default:
		return nil, fmt.Errorf("暂不支持在服务端解析该类型：%s", fileType)
	}
}

func markdownLocator() *string {
	value := "Markdown"
	return &value
}

func extractMarkdown(data []byte) *Result {
	text := normalizeLineEndings(string(data))
	return &Result{Text: text, Segments: []Segment{{StartOffset: 0, Locator: markdownLocator()}}}
}

func normalizeLineEndings(text string) string {
	return strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
}

// sheet 是一个工作表解析后的中间结果。
type sheet struct {
	name string
	text string
}

// joinSheets 把多个工作表拼成正文，并给出每个工作表的起始偏移。
// 分隔符与浏览器端一致："\n\f\n"（3 个字符）。
func joinSheets(sheets []sheet) *Result {
	texts := make([]string, 0, len(sheets))
	segments := make([]Segment, 0, len(sheets))
	cursor := 0
	for _, item := range sheets {
		name := item.name
		segments = append(segments, Segment{StartOffset: cursor, Locator: &name})
		texts = append(texts, item.text)
		cursor += len([]rune(item.text)) + 3
	}
	return &Result{Text: strings.Join(texts, "\n\f\n"), Segments: segments}
}

// rowsToSheetText 把二维单元格渲染成一段文本：首行当列名，
// 后续行的每个单元格前面带上 "列名: "，让单独一行分片也能看懂在说什么。
func rowsToSheetText(name string, rows [][]string) string {
	var header []string
	if len(rows) > 0 {
		header = rows[0]
	}
	lines := make([]string, 0, len(rows))
	for index, row := range rows {
		cells := make([]string, 0, len(row))
		for column, raw := range row {
			value := strings.TrimSpace(strings.Join(strings.Fields(raw), " "))
			if value == "" {
				continue
			}
			prefix := ""
			if index > 0 && column < len(header) {
				if key := strings.TrimSpace(header[column]); key != "" {
					prefix = key + ": "
				}
			}
			cells = append(cells, prefix+value)
		}
		if len(cells) > 0 {
			lines = append(lines, strings.Join(cells, " | "))
		}
	}
	return fmt.Sprintf("# %s\n\n%s", name, strings.Join(lines, "\n"))
}

func extractCSV(data []byte) (*Result, error) {
	reader := csv.NewReader(bytes.NewReader(data))
	reader.FieldsPerRecord = -1 // 允许每行列数不一致
	reader.LazyQuotes = true
	records, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("解析 CSV 失败: %w", err)
	}
	return joinSheets([]sheet{{name: "Sheet1", text: rowsToSheetText("Sheet1", records)}}), nil
}

func extractXLSX(data []byte) (*Result, error) {
	file, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("解析 Excel 失败: %w", err)
	}
	defer file.Close()

	sheets := make([]sheet, 0, len(file.GetSheetList()))
	for _, name := range file.GetSheetList() {
		rows, rowErr := file.GetRows(name)
		if rowErr != nil {
			return nil, fmt.Errorf("读取工作表 %s 失败: %w", name, rowErr)
		}
		sheets = append(sheets, sheet{name: name, text: rowsToSheetText(name, rows)})
	}
	if len(sheets) == 0 {
		return nil, fmt.Errorf("该 Excel 没有可读取的工作表")
	}
	return joinSheets(sheets), nil
}

// docxParagraph 对应 word/document.xml 里的一个段落；只取其中的文本节点。
// 用 stdlib 的 zip + xml 解析，避免为 docx 再引入一个依赖。
type docxParagraph struct {
	Runs []struct {
		Text string `xml:"t"`
	} `xml:"r"`
}

func extractDOCX(data []byte) (*Result, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, fmt.Errorf("解析 Word 失败: %w", err)
	}
	var documentXML []byte
	for _, file := range archive.File {
		if file.Name != "word/document.xml" {
			continue
		}
		reader, openErr := file.Open()
		if openErr != nil {
			return nil, fmt.Errorf("读取 Word 正文失败: %w", openErr)
		}
		documentXML, err = io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			return nil, fmt.Errorf("读取 Word 正文失败: %w", err)
		}
		break
	}
	if len(documentXML) == 0 {
		return nil, fmt.Errorf("该 Word 文件没有 word/document.xml")
	}

	decoder := xml.NewDecoder(bytes.NewReader(documentXML))
	lines := make([]string, 0, 256)
	for {
		token, tokenErr := decoder.Token()
		if tokenErr == io.EOF {
			break
		}
		if tokenErr != nil {
			return nil, fmt.Errorf("解析 Word 正文失败: %w", tokenErr)
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "p" {
			continue
		}
		var paragraph docxParagraph
		if err := decoder.DecodeElement(&paragraph, &start); err != nil {
			continue
		}
		var buf strings.Builder
		for _, run := range paragraph.Runs {
			buf.WriteString(run.Text)
		}
		if line := strings.TrimSpace(strings.Join(strings.Fields(buf.String()), " ")); line != "" {
			lines = append(lines, line)
		}
	}
	return &Result{Text: strings.Join(lines, "\n"), Segments: nil}, nil
}
