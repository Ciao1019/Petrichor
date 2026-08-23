// Package storage 本地对象存储（PETRICHOR_STORAGE_DIR），复刻 upload/local 语义。
package storage

import (
	"errors"
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
