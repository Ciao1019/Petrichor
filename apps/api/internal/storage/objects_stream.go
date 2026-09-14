package storage

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

// WriteObjectStream 有界接收文件到临时磁盘，避免大文件全部占用 Go 内存。
// 接收完整后本地原子替换，或由 Go 带已知长度上传 S3；失败不会发布半个文件。
func WriteObjectStream(ctx context.Context, key string, source io.Reader, contentType string, maxBytes int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if maxBytes <= 0 || maxBytes == 1<<63-1 {
		return ErrObjectTooLarge
	}
	key = StripS4KeyPrefix(key)
	dir, destination := "", ""
	if LocalEnabled() {
		var err error
		destination, err = resolveObjectPath(key)
		if err != nil {
			return err
		}
		dir = filepath.Dir(destination)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
	}
	file, err := os.CreateTemp(dir, ".petrichor-upload-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	size, err := io.Copy(file, io.LimitReader(localContextReader{ctx, source}, maxBytes+1))
	if err != nil {
		return err
	}
	if size > maxBytes {
		return ErrObjectTooLarge
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if destination != "" {
		if err := file.Close(); err != nil {
			return err
		}
		return os.Rename(file.Name(), destination)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	u, err := objectTransferURL("PUT", key)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, u, file)
	if err != nil {
		return err
	}
	request.ContentLength = size
	request.Header.Set("Content-Type", contentType)
	if size == 0 {
		request.Body = http.NoBody
	}
	response, err := objectTransferClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("对象上传连接失败")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &ObjectHTTPError{Status: response.StatusCode}
	}
	return ctx.Err()
}
