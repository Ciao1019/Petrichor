// Package satokenstore 提供 Sa-Token 的 PostgreSQL 持久化适配器。
package satokenstore

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var errKeyNotFound = errors.New("sa-token storage key not found")

const operationTimeout = 5 * time.Second

// Sa-Token Storage 接口不传 context，故每次数据库操作使用独立且有界的上下文，避免连接无限占用。
func operationContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), operationTimeout)
}

// Storage 将 Sa-Token 的键值和 TTL 持久化到 PostgreSQL。
type Storage struct {
	pool *pgxpool.Pool
}

// New 创建 PostgreSQL 存储适配器。
func New(pool *pgxpool.Pool) *Storage {
	return &Storage{pool: pool}
}

func encodeValue(value any) ([]byte, string, error) {
	switch typed := value.(type) {
	case string:
		return []byte(typed), "string", nil
	case []byte:
		return typed, "bytes", nil
	default:
		encoded, err := json.Marshal(value)
		return encoded, "json", err
	}
}

func decodeValue(data []byte, valueType string) (any, error) {
	switch valueType {
	case "string":
		return string(data), nil
	case "bytes":
		return data, nil
	default:
		var value any
		if err := json.Unmarshal(data, &value); err != nil {
			return nil, err
		}
		return value, nil
	}
}

func expirationTime(expiration time.Duration) *time.Time {
	if expiration <= 0 {
		return nil
	}
	expiresAt := time.Now().Add(expiration)
	return &expiresAt
}

// Set 写入键值并设置 TTL；非正 TTL 表示永不过期。
func (s *Storage) Set(key string, value any, expiration time.Duration) error {
	data, valueType, err := encodeValue(value)
	if err != nil {
		return err
	}
	ctx, cancel := operationContext()
	defer cancel()
	_, err = s.pool.Exec(ctx,
		`INSERT INTO sa_token_storage (key, value, value_type, expires_at)
		 VALUES ($1, $2, $3, $4)
		 ON CONFLICT (key) DO UPDATE
		 SET value = EXCLUDED.value,
		     value_type = EXCLUDED.value_type,
		     expires_at = EXCLUDED.expires_at,
		     updated_at = now()`,
		key, data, valueType, expirationTime(expiration))
	return err
}

// SetKeepTTL 更新键值但保留原过期时间。
func (s *Storage) SetKeepTTL(key string, value any) error {
	data, valueType, err := encodeValue(value)
	if err != nil {
		return err
	}
	ctx, cancel := operationContext()
	defer cancel()
	tag, err := s.pool.Exec(ctx,
		`UPDATE sa_token_storage
		 SET value = $2, value_type = $3, updated_at = now()
		 WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
		key, data, valueType)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errKeyNotFound
	}
	return nil
}

// Get 读取未过期的键；不存在时按 Sa-Token 约定返回 nil。
func (s *Storage) Get(key string) (any, error) {
	var (
		data      []byte
		valueType string
	)
	ctx, cancel := operationContext()
	defer cancel()
	err := s.pool.QueryRow(ctx,
		`SELECT value, value_type FROM sa_token_storage
		 WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`, key).
		Scan(&data, &valueType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return decodeValue(data, valueType)
}

// Delete 删除一个或多个键。
func (s *Storage) Delete(keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	ctx, cancel := operationContext()
	defer cancel()
	_, err := s.pool.Exec(ctx,
		`DELETE FROM sa_token_storage WHERE key = ANY($1)`, keys)
	return err
}

// Exists 判断键是否存在且未过期。
func (s *Storage) Exists(key string) bool {
	var exists bool
	ctx, cancel := operationContext()
	defer cancel()
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM sa_token_storage
			WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())
		)`, key).Scan(&exists)
	return err == nil && exists
}

func likePattern(pattern string) string {
	escaped := strings.NewReplacer(
		`\`, `\\`,
		`%`, `\%`,
		`_`, `\_`,
		`*`, `%`,
	).Replace(pattern)
	return escaped
}

// Keys 返回匹配 Sa-Token 星号模式的所有有效键。
func (s *Storage) Keys(pattern string) ([]string, error) {
	ctx, cancel := operationContext()
	defer cancel()
	rows, err := s.pool.Query(ctx,
		`SELECT key FROM sa_token_storage
		 WHERE key LIKE $1 ESCAPE '\' AND (expires_at IS NULL OR expires_at > now())
		 ORDER BY key`, likePattern(pattern))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	keys := make([]string, 0)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

// Expire 重设过期时间；非正 TTL 表示永不过期。
func (s *Storage) Expire(key string, expiration time.Duration) error {
	ctx, cancel := operationContext()
	defer cancel()
	tag, err := s.pool.Exec(ctx,
		`UPDATE sa_token_storage SET expires_at = $2, updated_at = now()
		 WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
		key, expirationTime(expiration))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errKeyNotFound
	}
	return nil
}

// TTL 返回剩余 TTL；-1 表示永不过期，-2 表示不存在或已过期。
func (s *Storage) TTL(key string) (time.Duration, error) {
	var expiresAt *time.Time
	ctx, cancel := operationContext()
	defer cancel()
	err := s.pool.QueryRow(ctx,
		`SELECT expires_at FROM sa_token_storage
		 WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`, key).
		Scan(&expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return -2 * time.Second, errKeyNotFound
	}
	if err != nil {
		return -2 * time.Second, err
	}
	if expiresAt == nil {
		return -1 * time.Second, nil
	}
	ttl := time.Until(*expiresAt)
	if ttl <= 0 {
		return -2 * time.Second, nil
	}
	return ttl, nil
}

// Clear 清空 Sa-Token 存储。
func (s *Storage) Clear() error {
	ctx, cancel := operationContext()
	defer cancel()
	_, err := s.pool.Exec(ctx, `DELETE FROM sa_token_storage`)
	return err
}

// Ping 检查数据库连接。
func (s *Storage) Ping() error {
	ctx, cancel := operationContext()
	defer cancel()
	return s.pool.Ping(ctx)
}
