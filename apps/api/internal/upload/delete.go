package upload

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

func DeleteObject(ctx context.Context, cfg *config.Config, objectKey string) error {
	key := StripS4KeyPrefix(objectKey)
	if key == "" {
		return fmt.Errorf("objectKey 为空")
	}
	parts := strings.Split(key, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("objectKey 非法")
		}
	}
	if strings.TrimSpace(cfg.LocalStorageDir) != "" {
		root, err := filepath.Abs(cfg.LocalStorageDir)
		if err != nil {
			return err
		}
		filePath, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(key)))
		if err != nil {
			return err
		}
		if filePath == root || !strings.HasPrefix(filePath, root+string(filepath.Separator)) {
			return fmt.Errorf("objectKey 越界")
		}
		if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if cfg.S3 == nil {
		return fmt.Errorf("未配置 S3 或本地对象存储")
	}
	signedURL, err := CreatePresignedURL(PresignInput{
		Method: "DELETE", ObjectKey: key, ExpiresSeconds: 60, S3: *cfg.S3,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, signedURL, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 300 || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
	return fmt.Errorf("S3 删除失败：HTTP %d：%s", resp.StatusCode, strings.TrimSpace(string(body)))
}
