package kb

import (
	"context"
	"fmt"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/internal/docextract"
	"github.com/Ciao1019/Petrichor/apps/api/internal/pdfinspector"
	"github.com/Ciao1019/Petrichor/apps/api/internal/upload"
)

// extractedDocument 是一次服务端解析的结果。
type extractedDocument struct {
	Text     string
	Segments []kbTextSegmentInput
}

// extractDocumentServerSide 尝试在服务端把原文件解析成正文。
//
//   - md / csv / xlsx / docx 由 internal/docextract 直接解析；
//   - PDF 需要版面能力，走 pdf-inspector sidecar（配置了才启用）；
//   - 解析不了或没配 sidecar 时返回 nil，调用方回退到客户端上传的正文。
//
// 注意这里只影响"正文从哪来"。分块始终在服务端执行，PDF 也不例外。
func (s *Service) extractDocumentServerSide(ctx context.Context, fileType, objectKey string) (*extractedDocument, error) {
	if docextract.SupportedFileType(fileType) {
		raw, err := s.fetchObject(ctx, objectKey)
		if err != nil {
			return nil, err
		}
		parsed, err := docextract.Extract(fileType, raw)
		if err != nil {
			return nil, err
		}
		return &extractedDocument{Text: parsed.Text, Segments: toKBTextSegments(parsed.Segments)}, nil
	}
	if strings.EqualFold(strings.TrimSpace(fileType), "pdf") {
		return s.extractPDFViaInspector(ctx, objectKey)
	}
	return nil, fmt.Errorf("类型 %s 不支持服务端解析", fileType)
}

// extractPDFViaInspector 调用 pdf-inspector sidecar 把 PDF 转成逐页 Markdown，
// 并按页给出分段边界。没有配置 sidecar 时直接返回错误，让调用方回退。
func (s *Service) extractPDFViaInspector(ctx context.Context, objectKey string) (*extractedDocument, error) {
	baseURL := ""
	if s.cfg != nil {
		baseURL = strings.TrimSpace(s.cfg.PDFInspectorURL)
	}
	if baseURL == "" {
		return nil, fmt.Errorf("未配置 pdf-inspector")
	}
	raw, err := s.fetchObject(ctx, objectKey)
	if err != nil {
		return nil, err
	}
	result, err := pdfinspector.New(baseURL).Extract(ctx, raw)
	if err != nil {
		return nil, err
	}

	texts := make([]string, 0, len(result.Pages))
	segments := make([]kbTextSegmentInput, 0, len(result.Pages))
	cursor := 0
	for _, page := range result.Pages {
		// sidecar 的 page 是 0-indexed，界面上按 1 开始展示。
		number := page.Page + 1
		locator := fmt.Sprintf("p.%d", number)
		pageNumber := number
		segments = append(segments, kbTextSegmentInput{StartOffset: cursor, Page: &pageNumber, Locator: &locator})
		texts = append(texts, page.Markdown)
		// 页之间用换页符连接，与浏览器端抽取的正文格式保持一致。
		cursor += len([]rune(page.Markdown)) + 3
	}
	text := strings.Join(texts, "\n\f\n")
	if strings.TrimSpace(text) == "" {
		return nil, fmt.Errorf("pdf-inspector 未解析出文本")
	}
	return &extractedDocument{Text: text, Segments: segments}, nil
}

// fetchObject 从对象存储（或本地存储）取回原文件字节。
func (s *Service) fetchObject(ctx context.Context, objectKey string) ([]byte, error) {
	return upload.FetchObjectBytes(ctx, s.cfg, objectKey)
}
