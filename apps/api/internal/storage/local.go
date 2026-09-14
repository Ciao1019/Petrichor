// Package storage 本地对象存储（PETRICHOR_STORAGE_DIR），复刻 upload/local 语义。
package storage

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"petrichor/api/internal/config"
)

// LocalEnabled 是否启用本地对象存储。
func LocalEnabled() bool {
	return config.Get().LocalStorageDir != ""
}

func resolveObjectPath(objectKey string) (string, error) {
	dir := config.Get().LocalStorageDir
	if dir == "" {
		return "", errors.New("未配置本地对象存储目录")
	}
	clean := filepath.Clean(strings.TrimPrefix(objectKey, "/"))
	if strings.HasPrefix(clean, "..") || filepath.IsAbs(clean) {
		return "", errors.New("非法对象键")
	}
	return filepath.Join(dir, clean), nil
}

// SaveLocalObject 写入对象。
func SaveLocalObject(objectKey string, data []byte) error {
	p, err := resolveObjectPath(objectKey)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o644)
}

// ReadLocalObject 读取对象；不存在返回 os.ErrNotExist。
func ReadLocalObject(objectKey string) ([]byte, error) {
	p, err := resolveObjectPath(objectKey)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(p)
}

var ErrObjectTooLarge = errors.New("对象超过读取上限")

// ReadLocalObjectLimited 仅供有界读取场景使用，不改变普通文档下载限制。
func ReadLocalObjectLimited(ctx context.Context, objectKey string, maxBytes int64) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if maxBytes <= 0 || maxBytes == 1<<63-1 {
		return nil, errors.New("读取上限无效")
	}
	p, err := resolveObjectPath(objectKey)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("对象不是普通文件")
	}
	if info.Size() > maxBytes {
		return nil, ErrObjectTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(localContextReader{ctx: ctx, reader: file}, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, ErrObjectTooLarge
	}
	return data, ctx.Err()
}

type localContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r localContextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}

// DeleteLocalObject 删除对象及其空父目录。
func DeleteLocalObject(objectKey string) error {
	p, err := resolveObjectPath(objectKey)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_ = os.Remove(filepath.Dir(p))
	return nil
}

// LocalObjectExists 对象是否存在。
func LocalObjectExists(objectKey string) bool {
	p, err := resolveObjectPath(objectKey)
	if err != nil {
		return false
	}
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}
