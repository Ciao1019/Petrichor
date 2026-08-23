// Package config 负责服务端环境变量加载，与 apps/web/src/config/server.ts 保持一致。
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultS3Region             = "us-east-1"
	DefaultS3UploadExpireSecs   = 900
	DefaultS3DownloadExpireSecs = 3600
	DefaultSessionExpireSecs    = 60 * 60 * 24 * 2
)

// S3Config S3 兼容对象存储配置；任一必填项缺失时为 nil（回退本地对象存储）。
type S3Config struct {
	AccessKeyID          string
	Bucket               string
	DownloadExpireSecond int
	Endpoint             string
	Region               string
	SecretAccessKey      string
	UploadExpireSeconds  int
	UseSSL               bool
}

// Config 服务端运行配置。
type Config struct {
	DatabaseURL         string
	LocalStorageDir     string
	S3                  *S3Config
	SessionExpire       time.Duration
	SessionSecret       string
	BaseURL             string
	RegisterEnabled     bool
	RegisterDefaultRole string // USER 或 SUPER_ADMIN
	APIPort             string
}

var cached *Config

func envTrim(key string) string {
	return strings.TrimSpace(os.Getenv(key))
}

func positiveInt(key string, fallback int) (int, error) {
	raw := envTrim(key)
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s 必须是正整数", key)
	}
	return n, nil
}

func Load() (*Config, error) {
	databaseURL := envTrim("DATABASE_URL")
	if databaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL: DATABASE_URL 不能为空")
	}
	sessionSecret := os.Getenv("SESSION_SECRET")
	if len(sessionSecret) < 32 {
		return nil, fmt.Errorf("SESSION_SECRET: SESSION_SECRET 至少需要 32 个字符")
	}
	sessionExpire, err := positiveInt("PETRICHOR_SESSION_EXPIRE_SECONDS", DefaultSessionExpireSecs)
	if err != nil {
		return nil, err
	}
	s3UploadExpire, err := positiveInt("S3_UPLOAD_EXPIRE_SECONDS", DefaultS3UploadExpireSecs)
	if err != nil {
		return nil, err
	}
	s3DownloadExpire, err := positiveInt("S3_DOWNLOAD_EXPIRE_SECONDS", DefaultS3DownloadExpireSecs)
	if err != nil {
		return nil, err
	}

	var s3 *S3Config
	endpoint := envTrim("S3_ENDPOINT")
	bucket := envTrim("S3_BUCKET")
	accessKey := envTrim("S3_ACCESS_KEY_ID")
	secretKey := envTrim("S3_SECRET_ACCESS_KEY")
	useSSL := true
	switch strings.ToLower(envTrim("S3_USE_SSL")) {
	case "false", "0", "no", "n":
		useSSL = false
	}
	if bucket != "" && accessKey != "" && secretKey != "" && endpoint != "" {
		if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
			scheme := "https"
			if !useSSL {
				scheme = "http"
			}
			endpoint = scheme + "://" + endpoint
		}
		endpoint = strings.TrimRight(endpoint, "/")
		region := envTrim("S3_REGION")
		if region == "" {
			region = DefaultS3Region
		}
		s3 = &S3Config{
			AccessKeyID:          accessKey,
			Bucket:               bucket,
			DownloadExpireSecond: s3DownloadExpire,
			Endpoint:             endpoint,
			Region:               region,
			SecretAccessKey:      secretKey,
			UploadExpireSeconds:  s3UploadExpire,
			UseSSL:               useSSL,
		}
	}

	registerEnabled := false
	switch strings.ToLower(envTrim("NEXT_PUBLIC_REGISTER_ENABLED")) {
	case "true", "1", "yes", "y":
		registerEnabled = true
	}
	registerDefaultRole := envTrim("PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE")
	if registerDefaultRole == "" {
		registerDefaultRole = "USER"
	}

	port := envTrim("PETRICHOR_API_PORT")
	if port == "" {
		port = "8080"
	}

	return &Config{
		DatabaseURL:         databaseURL,
		LocalStorageDir:     envTrim("PETRICHOR_STORAGE_DIR"),
		S3:                  s3,
		SessionExpire:       time.Duration(sessionExpire) * time.Second,
		SessionSecret:       sessionSecret,
		BaseURL:             ResolveBaseURL(),
		RegisterEnabled:     registerEnabled,
		RegisterDefaultRole: registerDefaultRole,
		APIPort:             port,
	}, nil
}

// Get 返回单例配置。
func Get() *Config {
	if cached == nil {
		cfg, err := Load()
		if err != nil {
			panic(fmt.Sprintf("服务端配置无效：%v", err))
		}
		cached = cfg
	}
	return cached
}

// IsProduction 生产环境判定（与 NODE_ENV === "production" 对齐）。
func IsProduction() bool {
	switch strings.TrimSpace(strings.ToLower(os.Getenv("NODE_ENV"))) {
	case "production", "prod":
		return true
	}
	return false
}

// ResolveBaseURL 复刻 src/server/public-site/site-url.ts 的回退链。
func ResolveBaseURL() string {
	for _, key := range []string{"NEXT_PUBLIC_APP_URL", "BETTER_AUTH_URL", "APP_BASE_URL"} {
		if v := envTrim(key); v != "" {
			return strings.TrimRight(v, "/")
		}
	}
	if v := envTrim("VERCEL_URL"); v != "" {
		return "https://" + strings.TrimRight(v, "/")
	}
	return "http://localhost:3000"
}
