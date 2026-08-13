package upload

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

// FetchObjectBytes 读取对象存储或本地存储中的文件。
func FetchObjectBytes(ctx context.Context, cfg *config.Config, objectKey string) ([]byte, error) {
	key := StripS4KeyPrefix(objectKey)
	if key == "" {
		return nil, fmt.Errorf("objectKey 为空")
	}
	if cfg.S3 != nil {
		url, err := CreatePresignedURL(PresignInput{
			Method:         "GET",
			ObjectKey:      key,
			ExpiresSeconds: 300,
			Now:            time.Now().UTC(),
			S3:             *cfg.S3,
		})
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
			return nil, fmt.Errorf("下载对象失败(%d): %s", resp.StatusCode, string(body))
		}
		return io.ReadAll(resp.Body)
	}
	if strings.TrimSpace(cfg.LocalStorageDir) == "" {
		return nil, fmt.Errorf("未配置 S3 或本地存储目录")
	}
	parts := strings.Split(key, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return nil, fmt.Errorf("objectKey 非法")
		}
	}
	root, err := filepath.Abs(cfg.LocalStorageDir)
	if err != nil {
		return nil, err
	}
	filePath, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(key)))
	if err != nil {
		return nil, err
	}
	if filePath == root || !strings.HasPrefix(filePath, root+string(filepath.Separator)) {
		return nil, fmt.Errorf("objectKey 越界")
	}
	return os.ReadFile(filePath)
}
