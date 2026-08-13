package upload

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

func StripS4KeyPrefix(key string) string {
	return strings.TrimPrefix(strings.TrimSpace(key), "s4key:")
}

func BuildObjectKey(userID int64, filename string) string {
	ext := strings.ToLower(path.Ext(filename))
	return BuildUserObjectPrefix(userID) + uuid.NewString() + ext
}

func BuildUserObjectPrefix(userID int64) string {
	return fmt.Sprintf("uploads/%d/", userID)
}

type PresignInput struct {
	Method         string
	ObjectKey      string
	ExpiresSeconds int
	Now            time.Time
	S3             config.S3Config
}

func CreatePresignedURL(input PresignInput) (string, error) {
	now := input.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	amzDate := now.Format("20060102T150405Z")
	dateStamp := amzDate[:8]
	credentialScope := fmt.Sprintf("%s/%s/s3/aws4_request", dateStamp, input.S3.Region)

	baseURL, err := virtualHostURL(input.S3.Endpoint, input.S3.Bucket)
	if err != nil {
		return "", err
	}
	canonicalURI := encodePathname(StripS4KeyPrefix(input.ObjectKey))
	params := [][2]string{
		{"X-Amz-Algorithm", "AWS4-HMAC-SHA256"},
		{"X-Amz-Credential", fmt.Sprintf("%s/%s", input.S3.AccessKeyID, credentialScope)},
		{"X-Amz-Date", amzDate},
		{"X-Amz-Expires", fmt.Sprintf("%d", input.ExpiresSeconds)},
		{"X-Amz-SignedHeaders", "host"},
	}
	query := canonicalQuery(params)
	canonicalRequest := strings.Join([]string{
		strings.ToUpper(input.Method),
		canonicalURI,
		query,
		fmt.Sprintf("host:%s\n", baseURL.Host),
		"host",
		"UNSIGNED-PAYLOAD",
	}, "\n")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		sha256Hex(canonicalRequest),
	}, "\n")
	signature := hmacHex(deriveSigningKey(input.S3.SecretAccessKey, dateStamp, input.S3.Region), stringToSign)

	baseURL.Path = canonicalURI
	baseURL.RawQuery = query + "&X-Amz-Signature=" + signature
	return baseURL.String(), nil
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

func encodePathname(objectKey string) string {
	parts := strings.Split(objectKey, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return "/" + strings.Join(parts, "/")
}

func encodeQuery(value string) string {
	escaped := url.QueryEscape(value)
	replacer := strings.NewReplacer("!", "%21", "'", "%27", "(", "%28", ")", "%29", "*", "%2A")
	return replacer.Replace(escaped)
}

func canonicalQuery(params [][2]string) string {
	sorted := append([][2]string(nil), params...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i][0] < sorted[j][0] })
	parts := make([]string, 0, len(sorted))
	for _, p := range sorted {
		parts = append(parts, encodeQuery(p[0])+"="+encodeQuery(p[1]))
	}
	return strings.Join(parts, "&")
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key []byte, value string) []byte {
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(value))
	return mac.Sum(nil)
}

func hmacHex(key []byte, value string) string {
	return hex.EncodeToString(hmacSHA256(key, value))
}

func deriveSigningKey(secretAccessKey, dateStamp, region string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secretAccessKey), dateStamp)
	kRegion := hmacSHA256(kDate, region)
	kService := hmacSHA256(kRegion, "s3")
	return hmacSHA256(kService, "aws4_request")
}
