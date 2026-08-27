package kb

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"petrichor/api/internal/config"
	"petrichor/api/internal/storage"
)

var s4KeyReferencePattern = regexp.MustCompile(`s4key:([^\s"'<>),\]}]+)`)

var (
	s4CleanupSlots     = make(chan struct{}, 2)
	s4DeleteHTTPClient = &http.Client{Timeout: 30 * time.Second}
	deleteS4ObjectImpl = deleteS4StorageObject
)

func normalizeOwnedS4ObjectKey(value string, userID int64) string {
	objectKey := strings.TrimSpace(storage.StripS4KeyPrefix(value))
	if objectKey == "" || !strings.HasPrefix(objectKey, fmt.Sprintf("uploads/%d/", userID)) {
		return ""
	}
	return objectKey
}

func addS4ObjectKeysFromString(keys map[string]struct{}, value string, userID int64) {
	if strings.HasPrefix(value, "s4key:") {
		if objectKey := normalizeOwnedS4ObjectKey(strings.TrimPrefix(value, "s4key:"), userID); objectKey != "" {
			keys[objectKey] = struct{}{}
		}
	}
	for _, match := range s4KeyReferencePattern.FindAllStringSubmatch(value, -1) {
		if len(match) < 2 {
			continue
		}
		if objectKey := normalizeOwnedS4ObjectKey(match[1], userID); objectKey != "" {
			keys[objectKey] = struct{}{}
		}
	}
}

func collectS4ObjectKeysFromJSONValue(keys map[string]struct{}, value any, userID int64) {
	switch typed := value.(type) {
	case string:
		addS4ObjectKeysFromString(keys, typed, userID)
	case []any:
		for _, item := range typed {
			collectS4ObjectKeysFromJSONValue(keys, item, userID)
		}
	case map[string]any:
		for _, item := range typed {
			collectS4ObjectKeysFromJSONValue(keys, item, userID)
		}
	}
}

// ExtractS4ObjectKeysFromArticleContent 从 Markdown 与递归 JSON 内容中提取当前用户拥有的 S4 对象键。
func ExtractS4ObjectKeysFromArticleContent(contentJSON *string, contentMD string, userID int64) []string {
	keys := map[string]struct{}{}
	if contentMD != "" {
		addS4ObjectKeysFromString(keys, contentMD, userID)
	}
	if contentJSON != nil && strings.TrimSpace(*contentJSON) != "" {
		var decoded any
		if err := json.Unmarshal([]byte(*contentJSON), &decoded); err == nil {
			collectS4ObjectKeysFromJSONValue(keys, decoded, userID)
		} else {
			addS4ObjectKeysFromString(keys, *contentJSON, userID)
		}
	}
	out := make([]string, 0, len(keys))
	for key := range keys {
		out = append(out, key)
	}
	return out
}

func collectArticleS4ObjectKeys(articles []ArticleRow, userID int64) []string {
	keys := map[string]struct{}{}
	for i := range articles {
		for _, key := range ExtractS4ObjectKeysFromArticleContent(articles[i].ContentJson, articles[i].ContentMd, userID) {
			keys[key] = struct{}{}
		}
	}
	return stringSetValues(keys)
}

func stringSetValues(set map[string]struct{}) []string {
	values := make([]string, 0, len(set))
	for value := range set {
		values = append(values, value)
	}
	return values
}

func uniqueOwnedS4ObjectKeys(userID int64, candidates []string) []string {
	keys := map[string]struct{}{}
	for _, candidate := range candidates {
		if key := normalizeOwnedS4ObjectKey(candidate, userID); key != "" {
			keys[key] = struct{}{}
		}
	}
	return stringSetValues(keys)
}

// RemovedS4ObjectKeys 返回旧内容中存在、但新内容已移除的对象键。
func RemovedS4ObjectKeys(previous, next []string) []string {
	nextSet := make(map[string]struct{}, len(next))
	for _, key := range next {
		nextSet[key] = struct{}{}
	}
	removed := make([]string, 0, len(previous))
	for _, key := range previous {
		if _, exists := nextSet[key]; !exists {
			removed = append(removed, key)
		}
	}
	return removed
}

func collectCandidateReferences(referenced, candidates map[string]struct{}, contentJSON *string, contentMD string, userID int64) {
	for _, key := range ExtractS4ObjectKeysFromArticleContent(contentJSON, contentMD, userID) {
		if _, candidate := candidates[key]; candidate {
			referenced[key] = struct{}{}
		}
	}
}

// loadReferencedS4ObjectKeys 删除前重新扫描文章、Wiki 页面和 Wiki 目录节点，避免误删派生副本仍在引用的图片。
func loadReferencedS4ObjectKeys(ctx context.Context, q execQuerier, userID int64, candidateKeys []string) (map[string]struct{}, error) {
	candidates := make(map[string]struct{}, len(candidateKeys))
	for _, key := range candidateKeys {
		candidates[key] = struct{}{}
	}
	referenced := map[string]struct{}{}
	if len(candidates) == 0 {
		return referenced, nil
	}

	articleRows, err := q.Query(ctx,
		`SELECT content_json, content_md FROM petrichor_kb_article WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	for articleRows.Next() {
		var contentJSON *string
		var contentMD string
		if err := articleRows.Scan(&contentJSON, &contentMD); err != nil {
			articleRows.Close()
			return nil, err
		}
		collectCandidateReferences(referenced, candidates, contentJSON, contentMD, userID)
	}
	if err := articleRows.Err(); err != nil {
		articleRows.Close()
		return nil, err
	}
	articleRows.Close()

	for _, query := range []string{
		`SELECT content_md FROM petrichor_kb_wiki_page WHERE user_id = $1`,
		`SELECT content_md FROM petrichor_kb_wiki_tree_node WHERE user_id = $1`,
	} {
		rows, queryErr := q.Query(ctx, query, userID)
		if queryErr != nil {
			return nil, queryErr
		}
		for rows.Next() {
			var contentMD string
			if scanErr := rows.Scan(&contentMD); scanErr != nil {
				rows.Close()
				return nil, scanErr
			}
			collectCandidateReferences(referenced, candidates, nil, contentMD, userID)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			rows.Close()
			return nil, rowsErr
		}
		rows.Close()
	}
	return referenced, nil
}

func deleteS4StorageObject(objectKey string) error {
	cfg := config.Get()
	if storage.LocalEnabled() {
		return storage.DeleteLocalObject(objectKey)
	}
	if cfg.S3 == nil {
		return errors.New("S3 存储未配置")
	}
	signedURL, err := storage.CreateS3PresignedUrl(cfg.S3, http.MethodDelete, objectKey, 60, time.Now())
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodDelete, signedURL, nil)
	if err != nil {
		return err
	}
	response, err := s4DeleteHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if (response.StatusCode >= 200 && response.StatusCode < 300) || response.StatusCode == http.StatusNotFound {
		return nil
	}
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	message := fmt.Sprintf("S3 删除失败：HTTP %d %s", response.StatusCode, http.StatusText(response.StatusCode))
	if detail := strings.TrimSpace(string(body)); detail != "" {
		if utf8.RuneCountInString(detail) > 500 {
			detail = string([]rune(detail)[:500])
		}
		message += "：" + detail
	}
	return errors.New(message)
}

func cleanupUnreferencedS4Objects(ctx context.Context, userID int64, candidateKeys []string, action string) {
	candidates := uniqueOwnedS4ObjectKeys(userID, candidateKeys)
	if len(candidates) == 0 {
		return
	}
	referenced, err := loadReferencedS4ObjectKeys(ctx, pool(), userID, candidates)
	if err != nil {
		slog.Warn("S4 图片引用扫描失败，已保留业务操作结果", "action", action, "userId", userID, "candidateCount", len(candidates), "err", err)
		return
	}
	deletable := make([]string, 0, len(candidates))
	for _, key := range candidates {
		if _, exists := referenced[key]; !exists {
			deletable = append(deletable, key)
		}
	}
	if len(deletable) == 0 {
		return
	}
	if !storage.LocalEnabled() && config.Get().S3 == nil {
		slog.Warn("跳过 S4 图片清理：对象存储未配置", "action", action, "userId", userID, "objectKeyCount", len(deletable))
		return
	}

	deleted := 0
	failed := 0
	for _, key := range deletable {
		if err := deleteS4ObjectImpl(key); err != nil {
			failed++
			slog.Warn("S4 图片对象清理失败", "action", action, "userId", userID, "objectKey", key, "err", err)
			continue
		}
		deleted++
	}
	if deleted > 0 || failed > 0 {
		slog.Info("S4 图片清理完成", "action", action, "userId", userID, "deletedCount", deleted, "failedCount", failed)
	}
}

// ScheduleUnreferencedS4Cleanup 在业务写入成功后异步清理当前用户已无引用的 S4 对象。
func ScheduleUnreferencedS4Cleanup(userID int64, candidateKeys []string, action string) {
	candidates := uniqueOwnedS4ObjectKeys(userID, candidateKeys)
	if len(candidates) == 0 {
		return
	}
	go func() {
		s4CleanupSlots <- struct{}{}
		defer func() {
			<-s4CleanupSlots
			if recovered := recover(); recovered != nil {
				slog.Error("S4 图片清理发生异常，已保留业务操作结果", "action", action, "userId", userID, "panic", recovered)
			}
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		cleanupUnreferencedS4Objects(ctx, userID, candidates, action)
	}()
}
