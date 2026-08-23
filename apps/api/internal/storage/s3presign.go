// Package storage 复刻 src/server/upload/s3-presign.ts 的 SigV4 预签名与本地对象存取。
package storage

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"petrichor/api/internal/config"
)

// StripS4KeyPrefix 去掉历史遗留的 s4key: 前缀。
func StripS4KeyPrefix(key string) string {
	return strings.TrimPrefix(strings.TrimSpace(key), "s4key:")
}

// BuildS3ObjectKey uploads/<userId>/<uuid><ext>。
func BuildS3ObjectKey(filename string, userID int64, uuid string) string {
	ext := ""
	if idx := strings.LastIndex(filename, "."); idx >= 0 {
		ext = strings.ToLower(filename[idx:])
	}
	if uuid == "" {
		uuid = NewUUID()
	}
	return fmt.Sprintf("uploads/%d/%s%s", userID, uuid, ext)
}

// NewUUID 生成 RFC4122 v4 UUID。
func NewUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func sha256Hex(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

func hmacBytes(key []byte, v string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(v))
	return mac.Sum(nil)
}

func deriveSigningKey(secretAccessKey, dateStamp, region string) []byte {
	kDate := hmacBytes([]byte("AWS4"+secretAccessKey), dateStamp)
	kRegion := hmacBytes(kDate, region)
	kService := hmacBytes(kRegion, "s3")
	return hmacBytes(kService, "aws4_request")
}

func encodeQuery(v string) string {
	s := url.QueryEscape(v)
	// 与 JS encodeURIComponent 对齐：Go QueryEscape 已编码 !'()*，无需额外处理差异项
	replacer := strings.NewReplacer("%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*")
	return replacer.Replace(s)
}

func encodePathname(objectKey string) string {
	parts := strings.Split(objectKey, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return "/" + strings.Join(parts, "/")
}

func virtualHostURL(endpoint, bucket string) (*url.URL, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	if parsed.Hostname() == bucket || strings.HasPrefix(parsed.Hostname(), bucket+".") {
		return parsed, nil
	}
	parsed.Host = bucket + "." + parsed.Host
	return parsed, nil
}

// CreateS3PresignedUrl 生成 SigV4 查询串预签名 URL。
func CreateS3PresignedUrl(cfg *config.S3Config, method, objectKey string, expiresSeconds int, now time.Time) (string, error) {
	amzDate := now.UTC().Format("20060102T150405Z")
	dateStamp := amzDate[:8]
	scope := dateStamp + "/" + cfg.Region + "/s3/aws4_request"

	baseURL, err := virtualHostURL(cfg.Endpoint, cfg.Bucket)
	if err != nil {
		return "", err
	}
	host := baseURL.Host
	canonicalURI := encodePathname(StripS4KeyPrefix(objectKey))

	params := [][2]string{
		{"X-Amz-Algorithm", "AWS4-HMAC-SHA256"},
		{"X-Amz-Credential", cfg.AccessKeyID + "/" + scope},
		{"X-Amz-Date", amzDate},
		{"X-Amz-Expires", fmt.Sprintf("%d", expiresSeconds)},
		{"X-Amz-SignedHeaders", "host"},
	}
	sort.Slice(params, func(i, j int) bool { return params[i][0] < params[j][0] })
	qs := make([]string, 0, len(params))
	for _, kv := range params {
		qs = append(qs, encodeQuery(kv[0])+"="+encodeQuery(kv[1]))
	}
	query := strings.Join(qs, "&")

	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI,
		query,
		"host:" + host + "\n",
		"host",
		"UNSIGNED-PAYLOAD",
	}, "\n")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		sha256Hex(canonicalRequest),
	}, "\n")
	signingKey := deriveSigningKey(cfg.SecretAccessKey, dateStamp, cfg.Region)
	signature := hex.EncodeToString(hmacBytes(signingKey, stringToSign))

	baseURL.Path = canonicalURI
	baseURL.RawQuery = query + "&X-Amz-Signature=" + signature
	return baseURL.String(), nil
}
