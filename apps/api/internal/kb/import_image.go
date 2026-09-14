package kb

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"time"

	"petrichor/api/internal/config"
	"petrichor/api/internal/storage"
)

const maxImportImageBytes = 20 << 20

var s3DownloadClient = &http.Client{Timeout: 120 * time.Second}

func fetchObjectBytes(ctx context.Context, objectKey string) ([]byte, string, error) {
	if err := ctx.Err(); err != nil {
		return nil, "", err
	}
	key := storage.StripS4KeyPrefix(objectKey)
	var data []byte
	var err error
	if storage.LocalEnabled() {
		data, err = storage.ReadLocalObjectLimited(ctx, key, maxImportImageBytes)
	} else {
		data, err = downloadPresignedObject(ctx, key)
	}
	if errors.Is(err, storage.ErrObjectTooLarge) {
		return nil, "", badReq("页面图片超过 20MiB，请重新上传")
	}
	if err != nil {
		return nil, "", err
	}
	// 限制可解码格式和像素上限；伪造扩展名/签名不能先发给模型。
	reader := func() io.Reader { return importImageReader{ctx, bytes.NewReader(data)} }
	cfg, format, err := image.DecodeConfig(reader())
	if ctx.Err() != nil {
		return nil, "", ctx.Err()
	}
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 24_000_000 {
		return nil, "", badReq("页面图片无效或尺寸过大，请重新上传 PNG、JPEG 或 GIF")
	}
	if _, _, err := image.Decode(reader()); err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", badReq("页面图片损坏，请重新上传")
	}
	return data, "image/" + format, ctx.Err()
}

type importImageReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r importImageReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

func downloadPresignedObject(ctx context.Context, key string) ([]byte, error) {
	s3cfg := config.Get().S3
	if s3cfg == nil {
		return nil, fmt.Errorf("对象存储未配置")
	}
	url, err := storage.CreateS3PresignedUrl(s3cfg, "GET", key, s3cfg.DownloadExpireSecond, time.Now())
	if err != nil {
		return nil, err
	}
	return downloadImportImage(ctx, url)
}

func downloadImportImage(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := s3DownloadClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("对象下载失败(HTTP %d)", response.StatusCode)
	}
	if response.ContentLength > maxImportImageBytes {
		return nil, storage.ErrObjectTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxImportImageBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxImportImageBytes {
		return nil, storage.ErrObjectTooLarge
	}
	return data, ctx.Err()
}
