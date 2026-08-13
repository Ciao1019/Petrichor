package pdfinspector

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client 调用 pdf-inspector sidecar（默认 PETRICHOR_PDF_INSPECTOR_URL）。
type Client struct {
	baseURL    string
	httpClient *http.Client
}

func New(baseURL string) *Client {
	return &Client{
		baseURL: strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		httpClient: &http.Client{
			Timeout: 180 * time.Second,
		},
	}
}

type Page struct {
	// Page 为 0-indexed，与 PDF sidecar 协议一致。
	Page      int     `json:"page"`
	Markdown  string  `json:"markdown"`
	NeedsOcr  bool    `json:"needsOcr"`
	OcrReason *string `json:"ocrReason"`
}

type ExtractResult struct {
	Pages     []Page `json:"pages"`
	IsComplex bool   `json:"isComplex"`
}

// Extract 上传原始 PDF 字节，返回逐页 Markdown。
func (c *Client) Extract(ctx context.Context, pdf []byte) (*ExtractResult, error) {
	if c.baseURL == "" {
		return nil, fmt.Errorf("pdf-inspector URL 未配置")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/extract", bytes.NewReader(pdf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/pdf")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("调用 pdf-inspector 失败: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("pdf-inspector 错误(%d): %s", resp.StatusCode, truncate(string(raw), 300))
	}
	var out ExtractResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("解析 pdf-inspector 响应失败: %w", err)
	}
	if len(out.Pages) == 0 {
		return nil, fmt.Errorf("未能从该 PDF 中解析出任何页面")
	}
	return &out, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
