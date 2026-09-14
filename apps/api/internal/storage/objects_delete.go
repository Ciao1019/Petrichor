package storage

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"petrichor/api/internal/config"
)

// DeleteObjectBounded 幂等删除一个配置内对象，不跟随重定向，最多等待 5 秒且不自动重试。
func DeleteObjectBounded(ctx context.Context, objectKey string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	key := StripS4KeyPrefix(objectKey)
	if !filepath.IsLocal(key) || filepath.Clean(key) == "." {
		return errors.New("非法对象键")
	}
	if LocalEnabled() {
		// os.Root 同时限制 .. 与中间目录符号链接，不允许删除存储根之外的对象。
		root, err := os.OpenRoot(config.Get().LocalStorageDir)
		if err != nil {
			return err
		}
		defer root.Close()
		info, err := root.Lstat(key)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.IsDir() {
			return errors.New("对象不是普通文件")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		err = root.Remove(key)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	u, err := objectTransferURL(http.MethodDelete, key)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, u, nil)
	if err != nil {
		return err
	}
	resp, err := objectTransferClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// 不在日志中暴露预签名 URL。
		return errors.New("对象删除连接失败")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || (resp.StatusCode >= 200 && resp.StatusCode < 300) {
		return nil
	}
	return &ObjectHTTPError{Status: resp.StatusCode}
}
