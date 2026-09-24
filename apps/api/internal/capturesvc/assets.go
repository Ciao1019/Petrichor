package capturesvc

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"petrichor/api/internal/config"
	"petrichor/api/internal/storage"
	"petrichor/api/internal/webcapture"
)

func persistAssets(ctx context.Context, j *Job, r *webcapture.Result) {
	prefix := fmt.Sprintf("uploads/%d/capture/%s/", j.UserID, j.ID)
	if r.MarkdownKey == "" {
		key := prefix + "source.md"
		if e := storage.WriteObjectBounded(ctx, key, []byte(r.Markdown), "text/markdown; charset=utf-8", webcapture.MaxMarkdownBytes); e == nil {
			r.MarkdownKey = key
		} else {
			r.Warnings = append(r.Warnings, "原文附件转存失败；完整正文仍保存在采集记录中")
		}
	}
	client := webcapture.PublicClient()
	defer client.CloseIdleConnections()
	for i := range r.Assets {
		a := &r.Assets[i]
		if a.Key != "" {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		key, e := persistImage(ctx, client, a.SourceURL, prefix+a.ID)
		if e != nil {
			a.Error = "图片转存失败，可访问原始来源；临时链接可能过期"
			r.Warnings = append(r.Warnings, a.Kind+" 转存失败")
			continue
		}
		a.Key = key
		a.Error = ""
	}
}
func persistImage(ctx context.Context, client *http.Client, source, key string) (string, error) {
	if _, e := webcapture.ValidateURL(ctx, source); e != nil {
		return "", e
	}
	req, e := http.NewRequestWithContext(ctx, "GET", source, nil)
	if e != nil {
		return "", e
	}
	resp, e := client.Do(req)
	if e != nil {
		return "", e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("media HTTP %d", resp.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, (10<<20)+1))
	if e != nil {
		return "", e
	}
	if len(b) > 10<<20 {
		return "", storage.ErrObjectTooLarge
	}
	mime := http.DetectContentType(b)
	extensions := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif"}
	ext, ok := extensions[mime]
	if !ok {
		return "", fmt.Errorf("不支持的图片格式")
	}
	key += ext
	if e = storage.WriteObjectBounded(ctx, key, b, mime, 10<<20); e != nil {
		return "", e
	}
	return key, nil
}
func signAssets(j *Job) {
	if j.Result == nil {
		return
	}
	prefix := fmt.Sprintf("uploads/%d/", j.UserID)
	for i := range j.Result.Assets {
		a := &j.Result.Assets[i]
		if a.Key == "" || !strings.HasPrefix(a.Key, prefix) {
			continue
		}
		if storage.LocalEnabled() {
			a.URL = storage.LocalObjectURL(a.Key)
		} else if cfg := config.Get().S3; cfg != nil {
			a.URL, _ = storage.CreateS3PresignedUrl(cfg, "GET", a.Key, 3600, time.Now())
		}
	}
}
