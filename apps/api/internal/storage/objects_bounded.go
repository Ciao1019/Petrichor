package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"petrichor/api/internal/config"
)

// 仅访问配置内对象存储的预签名地址；不跟随重定向到用户可控目的地。
var objectTransferClient = &http.Client{Timeout: 120 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

type ObjectHTTPError struct{ Status int }

func (e *ObjectHTTPError) Error() string { return fmt.Sprintf("对象传输失败(HTTP %d)", e.Status) }

func ReadObjectLimited(ctx context.Context, objectKey string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 || maxBytes == 1<<63-1 {
		return nil, errors.New("读取上限无效")
	}
	key := StripS4KeyPrefix(objectKey)
	if LocalEnabled() {
		return ReadLocalObjectLimited(ctx, key, maxBytes)
	}
	u, err := objectTransferURL("GET", key)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := objectTransferClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, errors.New("对象下载连接失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &ObjectHTTPError{Status: resp.StatusCode}
	}
	if resp.ContentLength > maxBytes {
		return nil, ErrObjectTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(localContextReader{ctx, resp.Body}, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrObjectTooLarge
	}
	return data, ctx.Err()
}

func objectTransferURL(method, key string) (string, error) {
	cfg := config.Get().S3
	if cfg == nil {
		return "", errors.New("对象存储未配置")
	}
	return CreateS3PresignedUrl(cfg, method, key, 600, time.Now())
}

// WriteObjectBounded 用上下文约束本地写入/预签名 PUT；图片必须在解析器回调返回前写完。
func WriteObjectBounded(ctx context.Context, key string, data []byte, contentType string, maxBytes int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if maxBytes <= 0 || int64(len(data)) > maxBytes {
		return ErrObjectTooLarge
	}
	key = StripS4KeyPrefix(key)
	if LocalEnabled() {
		return saveLocalObjectContext(ctx, key, data)
	}
	u, err := objectTransferURL("PUT", key)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := objectTransferClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("对象上传连接失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &ObjectHTTPError{Status: resp.StatusCode}
	}
	return ctx.Err()
}

func saveLocalObjectContext(ctx context.Context, key string, data []byte) error {
	p, err := resolveObjectPath(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(p), ".import-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, copyErr := io.Copy(file, localContextReader{ctx, bytes.NewReader(data)})
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return os.Rename(file.Name(), p)
}
