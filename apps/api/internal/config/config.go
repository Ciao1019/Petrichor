package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type S3Config struct {
	Endpoint              string
	Region                string
	AccessKeyID           string
	SecretAccessKey       string
	Bucket                string
	UploadExpireSeconds   int
	DownloadExpireSeconds int
	UseSSL                bool
}

type LinuxDoConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
}

const DefaultQuestionGenerationConcurrency = 20

// Config 服务端运行配置。
type Config struct {
	HTTPAddr                      string
	DatabaseURL                   string
	SessionCookieName             string
	SessionExpire                 time.Duration
	RegisterEnabled               bool
	RegisterDefaultSystemRole     string
	AppEnv                        string
	EncryptKey                    string
	EncryptSalt                   string
	AppURL                        string
	S3                            *S3Config
	LocalStorageDir               string
	RedisURL                      string
	RedisToken                    string
	LinuxDo                       LinuxDoConfig
	PDFInspectorURL               string
	QuestionGenerationConcurrency int
}

func Load() (*Config, error) {
	expireSeconds := envInt("PETRICHOR_SESSION_EXPIRE_SECONDS", 172800)
	cfg := &Config{
		HTTPAddr:                  env("HTTP_ADDR", ":8080"),
		DatabaseURL:               strings.TrimSpace(os.Getenv("DATABASE_URL")),
		SessionCookieName:         env("PETRICHOR_SESSION_COOKIE_NAME", "petrichor_session"),
		SessionExpire:             time.Duration(expireSeconds) * time.Second,
		RegisterEnabled:           envBool("PETRICHOR_REGISTER_ENABLED", false),
		RegisterDefaultSystemRole: strings.ToUpper(env("PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE", "USER")),
		AppEnv:                    env("APP_ENV", "development"),
		EncryptKey:                os.Getenv("PETRICHOR_ENCRYPT_KEY"),
		EncryptSalt:               os.Getenv("PETRICHOR_ENCRYPT_SALT"),
		AppURL:                    loadAppURL(),
		LocalStorageDir:           strings.TrimSpace(os.Getenv("PETRICHOR_STORAGE_DIR")),
		RedisURL:                  strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_URL")),
		RedisToken:                strings.TrimSpace(os.Getenv("UPSTASH_REDIS_REST_TOKEN")),
		LinuxDo: LinuxDoConfig{
			ClientID:     env("PETRICHOR_LINUXDO_CLIENT_ID", strings.TrimSpace(os.Getenv("LINUXDO_CLIENT_ID"))),
			ClientSecret: env("PETRICHOR_LINUXDO_CLIENT_SECRET", strings.TrimSpace(os.Getenv("LINUXDO_CLIENT_SECRET"))),
			RedirectURI:  env("PETRICHOR_LINUXDO_REDIRECT_URI", strings.TrimSpace(os.Getenv("LINUXDO_REDIRECT_URI"))),
		},
		PDFInspectorURL: env("PETRICHOR_PDF_INSPECTOR_URL", "http://127.0.0.1:8091"),
		QuestionGenerationConcurrency: envIntRange(
			"PETRICHOR_QUESTION_GENERATION_CONCURRENCY", DefaultQuestionGenerationConcurrency, 1, 100,
		),
	}
	if cfg.DatabaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL 未配置")
	}
	if cfg.RegisterDefaultSystemRole != "USER" && cfg.RegisterDefaultSystemRole != "SUPER_ADMIN" {
		return nil, fmt.Errorf("PETRICHOR_REGISTER_DEFAULT_SYSTEM_ROLE 只支持 USER 或 SUPER_ADMIN")
	}
	cfg.S3 = loadS3()
	return cfg, nil
}

func loadAppURL() string {
	if value := strings.TrimSpace(os.Getenv("APP_BASE_URL")); value != "" {
		return value
	}
	return "http://localhost:3000"
}

func loadS3() *S3Config {
	endpoint := strings.TrimSpace(os.Getenv("S3_ENDPOINT"))
	bucket := strings.TrimSpace(os.Getenv("S3_BUCKET"))
	accessKey := strings.TrimSpace(os.Getenv("S3_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("S3_SECRET_ACCESS_KEY"))
	if endpoint == "" || bucket == "" || accessKey == "" || secretKey == "" {
		return nil
	}
	return &S3Config{
		Endpoint:              endpoint,
		Region:                env("S3_REGION", "us-east-1"),
		AccessKeyID:           accessKey,
		SecretAccessKey:       secretKey,
		Bucket:                bucket,
		UploadExpireSeconds:   envInt("S3_UPLOAD_EXPIRE_SECONDS", 900),
		DownloadExpireSeconds: envInt("S3_DOWNLOAD_EXPIRE_SECONDS", 3600),
		UseSSL:                envBool("S3_USE_SSL", true),
	}
}

func (c *Config) IsProduction() bool {
	return c.AppEnv == "production"
}

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

func envIntRange(key string, fallback, minimum, maximum int) int {
	value := envInt(key, fallback)
	if value < minimum || value > maximum {
		return fallback
	}
	return value
}
