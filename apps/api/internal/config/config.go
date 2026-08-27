// Package config 负责从 apps/api/config.toml 加载 Go 服务配置。
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pelletier/go-toml/v2"
)

const (
	DefaultS3Region             = "us-east-1"
	DefaultS3UploadExpireSecs   = 900
	DefaultS3DownloadExpireSecs = 3600
	DefaultSessionExpireSecs    = 60 * 60 * 24 * 2
	DefaultAPIPort              = 8080
	DefaultBaseURL              = "http://localhost:3000"
	defaultEncryptKey           = "Ek4EhsOIVMQZ2gMAuJXJzUPjCZOjyKIt"
	defaultEncryptSalt          = "57da7a247bba15d0"
)

// S3Config S3 兼容对象存储配置。
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

type EncryptionConfig struct {
	Key  string
	Salt string
}

type UpstashConfig struct {
	RESTURL   string
	RESTToken string
}

type LinuxDoConfig struct {
	ClientID     string
	ClientSecret string
	RedirectURI  string
}

type LocalDevelopmentAuthConfig struct {
	Enabled bool
	UserID  int64
}

type AgentFeatureConfig struct {
	RuntimeV2     bool
	SoftRouter    bool
	DynamicSkills bool
	Delegation    bool
	Debug         bool
}

type AgentComplexityBudget struct {
	MaxIterations int `toml:"max_iterations"`
	MaxToolCalls  int `toml:"max_tool_calls"`
	MaxSubAgents  int `toml:"max_subagents"`
}

type AgentBudgetConfig struct {
	Direct             AgentComplexityBudget
	Simple             AgentComplexityBudget
	MultiStep          AgentComplexityBudget
	Complex            AgentComplexityBudget
	MaxExecutionMs     int64
	MaxTokens          int64
	MaxDelegationDepth int
	MaxNoProgress      int
	ToolTimeoutMs      int64
	ToolMaxRetries     int
	SubagentTimeoutMs  int64
	ContextTokens      int64
}

type AgentModelConfig struct {
	BaseURL string
	APIKey  string
	Model   string
}

// AgentResearchConfig 外部研究搜索配置。网页抓取不需要密钥；search 通过
// provider 选择 Tavily / Serper / Brave / SearXNG。
type AgentResearchConfig struct {
	Provider  string
	APIKey    string
	BaseURL   string
	TimeoutMs int64
}

type AgentConfig struct {
	SkillsDirectory string
	Features        AgentFeatureConfig
	Budget          AgentBudgetConfig
	Model           AgentModelConfig
	Research        AgentResearchConfig
}

// Config 是完成默认值与校验后的运行时配置。
type Config struct {
	Path                 string
	Environment          string
	Host                 string
	APIPort              string
	BaseURL              string
	DatabaseURL          string
	MigrationDatabaseURL string
	LocalStorageDir      string
	S3                   *S3Config
	SessionExpire        time.Duration
	SessionSecret        string
	RegisterEnabled      bool
	RegisterDefaultRole  string
	Encryption           EncryptionConfig
	Upstash              *UpstashConfig
	LinuxDo              LinuxDoConfig
	LocalDevelopmentAuth LocalDevelopmentAuthConfig
	Agent                AgentConfig
}

type fileConfig struct {
	Server     serverFileConfig     `toml:"server"`
	Database   databaseFileConfig   `toml:"database"`
	Auth       authFileConfig       `toml:"auth"`
	Encryption encryptionFileConfig `toml:"encryption"`
	Storage    storageFileConfig    `toml:"storage"`
	Cache      cacheFileConfig      `toml:"cache"`
	Agent      agentFileConfig      `toml:"agent"`
}

type serverFileConfig struct {
	Environment string `toml:"environment"`
	Host        string `toml:"host"`
	Port        int    `toml:"port"`
	BaseURL     string `toml:"base_url"`
}

type databaseFileConfig struct {
	URL          string `toml:"url"`
	MigrationURL string `toml:"migration_url"`
}

type authFileConfig struct {
	SessionSecret       string                     `toml:"session_secret"`
	SessionExpireSecond int                        `toml:"session_expire_seconds"`
	RegisterEnabled     bool                       `toml:"register_enabled"`
	DefaultSystemRole   string                     `toml:"default_system_role"`
	LinuxDo             linuxDoFileConfig          `toml:"linuxdo"`
	LocalDevelopment    localDevelopmentFileConfig `toml:"local_development"`
}

type linuxDoFileConfig struct {
	ClientID     string `toml:"client_id"`
	ClientSecret string `toml:"client_secret"`
	RedirectURI  string `toml:"redirect_uri"`
}

type localDevelopmentFileConfig struct {
	Enabled bool  `toml:"enabled"`
	UserID  int64 `toml:"user_id"`
}

type encryptionFileConfig struct {
	Key  string `toml:"key"`
	Salt string `toml:"salt"`
}

type storageFileConfig struct {
	LocalDirectory string       `toml:"local_directory"`
	S3             s3FileConfig `toml:"s3"`
}

type s3FileConfig struct {
	Endpoint              string `toml:"endpoint"`
	Region                string `toml:"region"`
	AccessKeyID           string `toml:"access_key_id"`
	SecretAccessKey       string `toml:"secret_access_key"`
	Bucket                string `toml:"bucket"`
	UploadExpireSeconds   int    `toml:"upload_expire_seconds"`
	DownloadExpireSeconds int    `toml:"download_expire_seconds"`
	UseSSL                *bool  `toml:"use_ssl"`
}

type cacheFileConfig struct {
	Upstash upstashFileConfig `toml:"upstash"`
}

type upstashFileConfig struct {
	RESTURL   string `toml:"rest_url"`
	RESTToken string `toml:"rest_token"`
}

type agentFileConfig struct {
	SkillsDirectory string                  `toml:"skills_directory"`
	Features        agentFeaturesFileConfig `toml:"features"`
	Budget          agentBudgetFileConfig   `toml:"budget"`
	Model           agentModelFileConfig    `toml:"model"`
	Research        agentResearchFileConfig `toml:"research"`
}

type agentFeaturesFileConfig struct {
	RuntimeV2     *bool `toml:"runtime_v2"`
	SoftRouter    *bool `toml:"soft_router"`
	DynamicSkills *bool `toml:"dynamic_skills"`
	Delegation    *bool `toml:"delegation"`
	Debug         *bool `toml:"debug"`
}

type agentBudgetFileConfig struct {
	Direct             AgentComplexityBudget `toml:"direct"`
	Simple             AgentComplexityBudget `toml:"simple"`
	MultiStep          AgentComplexityBudget `toml:"multi_step"`
	Complex            AgentComplexityBudget `toml:"complex"`
	MaxExecutionMs     int64                 `toml:"max_execution_ms"`
	MaxTokens          int64                 `toml:"max_tokens"`
	MaxDelegationDepth int                   `toml:"max_delegation_depth"`
	MaxNoProgress      int                   `toml:"max_no_progress"`
	ToolTimeoutMs      int64                 `toml:"tool_timeout_ms"`
	ToolMaxRetries     int                   `toml:"tool_max_retries"`
	SubagentTimeoutMs  int64                 `toml:"subagent_timeout_ms"`
	ContextTokens      int64                 `toml:"context_tokens"`
}

type agentModelFileConfig struct {
	BaseURL string `toml:"base_url"`
	APIKey  string `toml:"api_key"`
	Model   string `toml:"model"`
}

type agentResearchFileConfig struct {
	Provider  string `toml:"provider"`
	APIKey    string `toml:"api_key"`
	BaseURL   string `toml:"base_url"`
	TimeoutMs int64  `toml:"timeout_ms"`
}

var (
	cached  *Config
	cacheMu sync.RWMutex
)

// Load 查找并加载 apps/api/config.toml。
func Load() (*Config, error) {
	path, err := findConfigPath("config.toml")
	if err != nil {
		return nil, err
	}
	return LoadFile(path)
}

// LoadFile 加载指定 TOML 文件，便于测试与工具显式使用。
func LoadFile(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取 Go 配置失败 %s: %w", path, err)
	}

	var raw fileConfig
	decoder := toml.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&raw); err != nil {
		return nil, fmt.Errorf("解析 Go 配置失败 %s: %w", path, err)
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		absPath = path
	}
	return normalizeAndValidate(raw, absPath)
}

// Initialize 在服务启动时严格加载配置并设为全局实例。
func Initialize() (*Config, error) {
	cfg, err := Load()
	if err != nil {
		return nil, err
	}
	cacheMu.Lock()
	cached = cfg
	cacheMu.Unlock()
	return cfg, nil
}

// Get 返回已初始化的配置。测试进程没有 config.toml 时使用无密钥默认值，
// 正式服务由 main 中的 Initialize 保证缺失配置会直接启动失败。
func Get() *Config {
	cacheMu.RLock()
	cfg := cached
	cacheMu.RUnlock()
	if cfg != nil {
		return cfg
	}
	if loaded, err := Load(); err == nil {
		cacheMu.Lock()
		cached = loaded
		cacheMu.Unlock()
		return loaded
	}
	if strings.HasSuffix(os.Args[0], ".test") {
		return testDefaults()
	}
	panic("Go 配置尚未初始化")
}

func normalizeAndValidate(raw fileConfig, path string) (*Config, error) {
	environment := strings.ToLower(strings.TrimSpace(raw.Server.Environment))
	if environment == "" {
		environment = "development"
	}
	if environment != "development" && environment != "test" && environment != "production" {
		return nil, fmt.Errorf("server.environment 只支持 development、test 或 production")
	}

	host := strings.TrimSpace(raw.Server.Host)
	if host == "" {
		host = "0.0.0.0"
	}
	port := raw.Server.Port
	if port == 0 {
		port = DefaultAPIPort
	}
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("server.port 必须在 1 到 65535 之间")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(raw.Server.BaseURL), "/")
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}

	databaseURL := strings.TrimSpace(raw.Database.URL)
	if databaseURL == "" {
		return nil, fmt.Errorf("database.url 不能为空")
	}
	if len(raw.Auth.SessionSecret) < 32 {
		return nil, fmt.Errorf("auth.session_secret 至少需要 32 个字符")
	}
	sessionExpire := raw.Auth.SessionExpireSecond
	if sessionExpire == 0 {
		sessionExpire = DefaultSessionExpireSecs
	}
	if sessionExpire < 1 {
		return nil, fmt.Errorf("auth.session_expire_seconds 必须是正整数")
	}
	defaultRole := strings.ToUpper(strings.TrimSpace(raw.Auth.DefaultSystemRole))
	if defaultRole == "" {
		defaultRole = "USER"
	}
	if defaultRole != "USER" && defaultRole != "SUPER_ADMIN" {
		return nil, fmt.Errorf("auth.default_system_role 只支持 USER 或 SUPER_ADMIN")
	}
	if raw.Auth.LocalDevelopment.Enabled {
		if environment != "development" {
			return nil, fmt.Errorf("auth.local_development 只能在 development 环境启用")
		}
		if raw.Auth.LocalDevelopment.UserID <= 0 {
			return nil, fmt.Errorf("auth.local_development.user_id 必须是正整数")
		}
	}

	s3, err := normalizeS3(raw.Storage.S3)
	if err != nil {
		return nil, err
	}
	upstash, err := normalizeUpstash(raw.Cache.Upstash)
	if err != nil {
		return nil, err
	}

	encryptionKey := strings.TrimSpace(raw.Encryption.Key)
	if encryptionKey == "" {
		encryptionKey = defaultEncryptKey
	}
	encryptionSalt := strings.TrimSpace(raw.Encryption.Salt)
	if encryptionSalt == "" {
		encryptionSalt = defaultEncryptSalt
	}

	return &Config{
		Path:                 path,
		Environment:          environment,
		Host:                 host,
		APIPort:              strconv.Itoa(port),
		BaseURL:              baseURL,
		DatabaseURL:          databaseURL,
		MigrationDatabaseURL: strings.TrimSpace(raw.Database.MigrationURL),
		LocalStorageDir:      strings.TrimSpace(raw.Storage.LocalDirectory),
		S3:                   s3,
		SessionExpire:        time.Duration(sessionExpire) * time.Second,
		SessionSecret:        raw.Auth.SessionSecret,
		RegisterEnabled:      raw.Auth.RegisterEnabled,
		RegisterDefaultRole:  defaultRole,
		Encryption:           EncryptionConfig{Key: encryptionKey, Salt: encryptionSalt},
		Upstash:              upstash,
		LinuxDo: LinuxDoConfig{
			ClientID:     strings.TrimSpace(raw.Auth.LinuxDo.ClientID),
			ClientSecret: strings.TrimSpace(raw.Auth.LinuxDo.ClientSecret),
			RedirectURI:  strings.TrimSpace(raw.Auth.LinuxDo.RedirectURI),
		},
		LocalDevelopmentAuth: LocalDevelopmentAuthConfig{
			Enabled: raw.Auth.LocalDevelopment.Enabled,
			UserID:  raw.Auth.LocalDevelopment.UserID,
		},
		Agent: normalizeAgent(raw.Agent),
	}, nil
}

func normalizeS3(raw s3FileConfig) (*S3Config, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(raw.Endpoint), "/")
	bucket := strings.TrimSpace(raw.Bucket)
	accessKey := strings.TrimSpace(raw.AccessKeyID)
	secretKey := strings.TrimSpace(raw.SecretAccessKey)
	configured := endpoint != "" || bucket != "" || accessKey != "" || secretKey != ""
	if !configured {
		return nil, nil
	}
	if endpoint == "" || bucket == "" || accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("storage.s3 配置不完整：endpoint、bucket、access_key_id、secret_access_key 必须同时填写")
	}
	useSSL := true
	if raw.UseSSL != nil {
		useSSL = *raw.UseSSL
	}
	if !strings.HasPrefix(endpoint, "http://") && !strings.HasPrefix(endpoint, "https://") {
		scheme := "https"
		if !useSSL {
			scheme = "http"
		}
		endpoint = scheme + "://" + endpoint
	}
	region := strings.TrimSpace(raw.Region)
	if region == "" {
		region = DefaultS3Region
	}
	uploadExpire := raw.UploadExpireSeconds
	if uploadExpire == 0 {
		uploadExpire = DefaultS3UploadExpireSecs
	}
	downloadExpire := raw.DownloadExpireSeconds
	if downloadExpire == 0 {
		downloadExpire = DefaultS3DownloadExpireSecs
	}
	if uploadExpire < 1 || downloadExpire < 1 {
		return nil, fmt.Errorf("storage.s3 的过期秒数必须是正整数")
	}
	return &S3Config{
		AccessKeyID:          accessKey,
		Bucket:               bucket,
		DownloadExpireSecond: downloadExpire,
		Endpoint:             endpoint,
		Region:               region,
		SecretAccessKey:      secretKey,
		UploadExpireSeconds:  uploadExpire,
		UseSSL:               useSSL,
	}, nil
}

func normalizeUpstash(raw upstashFileConfig) (*UpstashConfig, error) {
	url := strings.TrimRight(strings.TrimSpace(raw.RESTURL), "/")
	token := strings.TrimSpace(raw.RESTToken)
	if url == "" && token == "" {
		return nil, nil
	}
	if url == "" || token == "" {
		return nil, fmt.Errorf("cache.upstash.rest_url 与 cache.upstash.rest_token 必须同时填写")
	}
	return &UpstashConfig{RESTURL: url, RESTToken: token}, nil
}

func normalizeAgent(raw agentFileConfig) AgentConfig {
	researchTimeout := raw.Research.TimeoutMs
	if researchTimeout <= 0 {
		researchTimeout = 12_000
	}
	return AgentConfig{
		SkillsDirectory: strings.TrimSpace(raw.SkillsDirectory),
		Features: AgentFeatureConfig{
			RuntimeV2:     boolOrDefault(raw.Features.RuntimeV2, true),
			SoftRouter:    boolOrDefault(raw.Features.SoftRouter, true),
			DynamicSkills: boolOrDefault(raw.Features.DynamicSkills, true),
			Delegation:    boolOrDefault(raw.Features.Delegation, true),
			Debug:         boolOrDefault(raw.Features.Debug, false),
		},
		Budget: AgentBudgetConfig{
			Direct:             raw.Budget.Direct,
			Simple:             raw.Budget.Simple,
			MultiStep:          raw.Budget.MultiStep,
			Complex:            raw.Budget.Complex,
			MaxExecutionMs:     raw.Budget.MaxExecutionMs,
			MaxTokens:          raw.Budget.MaxTokens,
			MaxDelegationDepth: raw.Budget.MaxDelegationDepth,
			MaxNoProgress:      raw.Budget.MaxNoProgress,
			ToolTimeoutMs:      raw.Budget.ToolTimeoutMs,
			ToolMaxRetries:     raw.Budget.ToolMaxRetries,
			SubagentTimeoutMs:  raw.Budget.SubagentTimeoutMs,
			ContextTokens:      raw.Budget.ContextTokens,
		},
		Model: AgentModelConfig{
			BaseURL: strings.TrimSpace(raw.Model.BaseURL),
			APIKey:  strings.TrimSpace(raw.Model.APIKey),
			Model:   strings.TrimSpace(raw.Model.Model),
		},
		Research: AgentResearchConfig{
			Provider:  strings.ToLower(strings.TrimSpace(raw.Research.Provider)),
			APIKey:    strings.TrimSpace(raw.Research.APIKey),
			BaseURL:   strings.TrimRight(strings.TrimSpace(raw.Research.BaseURL), "/"),
			TimeoutMs: researchTimeout,
		},
	}
}

func boolOrDefault(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func findConfigPath(name string) (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("获取当前目录失败: %w", err)
	}
	for {
		candidate := filepath.Join(directory, name)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate, nil
		}
		workspaceCandidate := filepath.Join(directory, "apps", "api", name)
		if info, statErr := os.Stat(workspaceCandidate); statErr == nil && !info.IsDir() {
			return workspaceCandidate, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	return "", fmt.Errorf("未找到 apps/api/%s，请从 config.example.toml 复制并填写", name)
}

func testDefaults() *Config {
	return &Config{
		Environment:         "test",
		Host:                "127.0.0.1",
		APIPort:             strconv.Itoa(DefaultAPIPort),
		BaseURL:             DefaultBaseURL,
		SessionExpire:       DefaultSessionExpireSecs * time.Second,
		RegisterDefaultRole: "USER",
		Encryption: EncryptionConfig{
			Key:  defaultEncryptKey,
			Salt: defaultEncryptSalt,
		},
		Agent: normalizeAgent(agentFileConfig{}),
	}
}

// IsProduction 判断当前是否为生产环境。
func IsProduction() bool {
	return Get().Environment == "production"
}

// ResolveBaseURL 返回 TOML 中配置的公开站点地址。
func ResolveBaseURL() string {
	return Get().BaseURL
}
