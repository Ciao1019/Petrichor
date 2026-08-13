package kb

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// BuildArticleAiSummaryContentHash 与 Node buildPublicArticleContentHash 一致：md5(content_md)。
func BuildArticleAiSummaryContentHash(contentMd string) string {
	sum := md5.Sum([]byte(contentMd))
	return hex.EncodeToString(sum[:])
}

// BuildMindmapContentHash 与 Node buildMindmapContentHash 一致：sha256(title + "\n" + contentMd)。
func BuildMindmapContentHash(title, contentMd string) string {
	payload := strings.TrimSpace(title) + "\n" + strings.TrimSpace(contentMd)
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}
