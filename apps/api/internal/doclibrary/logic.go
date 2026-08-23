// Package doclibrary 移植 src/server/doc-library/library-logic.ts：
// 文档库 / 文件夹 / 文档三层的租户隔离 CRUD、缓存与存储清理。
package doclibrary

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/cache"
	"petrichor/api/internal/config"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
	"petrichor/api/internal/storage"
)

// MaxChunks 单篇文档的分块数量上限。
const MaxChunks = 4000

// MaxChunkChars 单个分块的文本长度上限。
const MaxChunkChars = 4000

// FileTypes 支持的文件类型（与 FILE_TYPES 常量一致）。
var FileTypes = map[string]struct{}{
	"pdf":  {},
	"docx": {},
	"xlsx": {},
	"csv":  {},
}

var whitespacePattern = regexp.MustCompile(`\s+`)

// ===== 缓存键（按用户隔离，与 TS 键规则逐字对齐） =====

func docLibraryListKey(userID int64) string {
	return cache.CacheKey("doclib", strconv.FormatInt(userID, 10), "libraries")
}

func docFolderListKey(userID, libraryID int64) string {
	return cache.CacheKey("doclib", strconv.FormatInt(userID, 10), "lib",
		strconv.FormatInt(libraryID, 10), "folders")
}

func docDocumentListKey(userID, libraryID int64) string {
	return cache.CacheKey("doclib", strconv.FormatInt(userID, 10), "lib",
		strconv.FormatInt(libraryID, 10), "documents")
}

func docDocumentDetailKey(userID, documentID int64) string {
	return cache.CacheKey("doclib", strconv.FormatInt(userID, 10), "doc",
		strconv.FormatInt(documentID, 10))
}

// invalidateDocLibraryCache 失效某用户文档库下的全部缓存。
func invalidateDocLibraryCache(userID int64) {
	prefix := cache.CacheKey("doclib", strconv.FormatInt(userID, 10)) + ":"
	cache.DropByPrefix(prefix)
}

// ===== 存储清理（对应 s3-delete.deleteS3Objects） =====

// S3DeleteFailure 删除失败记录。
type S3DeleteFailure struct {
	ErrorMessage string `json:"errorMessage"`
	ObjectKey    string `json:"objectKey"`
	Status       int    `json:"status,omitempty"`
}

// StorageCleanupSummary 文档删除后的对象存储清理结果。
type StorageCleanupSummary struct {
	DeletedObjectKeys []string          `json:"deletedObjectKeys"`
	FailedObjectKeys  []S3DeleteFailure `json:"failedObjectKeys"`
}

var deleteHTTPClient = &http.Client{Timeout: 30 * time.Second}

// deleteRemoteObject 走 SigV4 预签名 DELETE 删除远端对象；404 视为成功。
func deleteRemoteObject(cfg *config.S3Config, objectKey string) error {
	signedURL, err := storage.CreateS3PresignedUrl(cfg, "DELETE", objectKey, 60, time.Now())
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodDelete, signedURL, nil)
	if err != nil {
		return err
	}
	resp, err := deleteHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if (resp.StatusCode >= 200 && resp.StatusCode < 300) || resp.StatusCode == http.StatusNotFound {
		return nil
	}
	detail := strings.TrimSpace(string(body))
	msg := fmt.Sprintf("S3 删除失败：HTTP %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	if detail != "" {
		cut := detail
		if utf8.RuneCountInString(cut) > 500 {
			cut = string([]rune(cut)[:500])
		}
		msg += "：" + cut
	}
	return errors.New(msg)
}

// deleteObjects 复刻 deleteS3Objects：本地模式优先，其次 S3，双缺失报错。
func deleteObjects(objectKeys []string) StorageCleanupSummary {
	summary := StorageCleanupSummary{
		DeletedObjectKeys: []string{},
		FailedObjectKeys:  []S3DeleteFailure{},
	}
	cfg := config.Get()
	for _, key := range objectKeys {
		var err error
		switch {
		case storage.LocalEnabled():
			err = storage.DeleteLocalObject(key)
		case cfg.S3 != nil:
			err = deleteRemoteObject(cfg.S3, key)
		default:
			err = errors.New("S3 存储未配置")
		}
		if err != nil {
			summary.FailedObjectKeys = append(summary.FailedObjectKeys,
				S3DeleteFailure{ErrorMessage: err.Error(), ObjectKey: key})
			continue
		}
		summary.DeletedObjectKeys = append(summary.DeletedObjectKeys, key)
	}
	return summary
}

// normalizeOwnedDocumentObjectKey 校验对象键归属当前用户。
func normalizeOwnedDocumentObjectKey(objectKey string, userID int64) (string, *S3DeleteFailure) {
	key := strings.TrimSpace(storage.StripS4KeyPrefix(objectKey))
	if key == "" {
		return "", &S3DeleteFailure{ErrorMessage: "文档对象键为空", ObjectKey: objectKey}
	}
	if !strings.HasPrefix(key, fmt.Sprintf("uploads/%d/", userID)) {
		return "", &S3DeleteFailure{
			ErrorMessage: "文档对象键不属于当前用户，已跳过远程删除",
			ObjectKey:    key,
		}
	}
	return key, nil
}

// cleanupDocumentObjectKeys 归一化并删除文档对象，输出清理摘要。
func cleanupDocumentObjectKeys(userID int64, objectKeys []string) StorageCleanupSummary {
	unique := make([]string, 0, len(objectKeys))
	seen := make(map[string]struct{}, len(objectKeys))
	for _, key := range objectKeys {
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, key)
	}

	normalizedKeys := make([]string, 0, len(unique))
	failed := []S3DeleteFailure{}
	for _, objectKey := range unique {
		key, failure := normalizeOwnedDocumentObjectKey(objectKey, userID)
		if failure != nil {
			failed = append(failed, *failure)
			continue
		}
		normalizedKeys = append(normalizedKeys, key)
	}

	if len(normalizedKeys) == 0 {
		return StorageCleanupSummary{DeletedObjectKeys: []string{}, FailedObjectKeys: failed}
	}

	summary := deleteObjects(normalizedKeys)
	summary.FailedObjectKeys = append(failed, summary.FailedObjectKeys...)
	return summary
}

// ===== 数据行与响应映射 =====

type libraryRow struct {
	ID            int64
	UserID        int64
	Name          string
	Description   *string
	Color         *string
	Icon          *string
	DocumentCount int32
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

func scanLibrary(row pgx.Row) (*libraryRow, error) {
	var r libraryRow
	err := row.Scan(&r.ID, &r.UserID, &r.Name, &r.Description, &r.Color, &r.Icon,
		&r.DocumentCount, &r.CreatedAt, &r.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

const libraryColumns = `id, user_id, name, description, color, icon, document_count, created_at, updated_at`

func (r *libraryRow) toResponse() map[string]any {
	return map[string]any{
		"id":            strconv.FormatInt(r.ID, 10),
		"name":          r.Name,
		"description":   r.Description,
		"color":         r.Color,
		"icon":          r.Icon,
		"documentCount": r.DocumentCount,
		"createdAt":     httpx.FormatISO(r.CreatedAt),
		"updatedAt":     httpx.FormatISO(r.UpdatedAt),
	}
}

type folderRow struct {
	ID        int64
	UserID    int64
	LibraryID int64
	ParentID  *int64
	Name      string
	SortOrder int32
	CreatedAt time.Time
	UpdatedAt time.Time
}

const folderColumns = `id, user_id, library_id, parent_id, name, sort_order, created_at, updated_at`

func (r *folderRow) toResponse() map[string]any {
	parentID := any(nil)
	if r.ParentID != nil {
		parentID = strconv.FormatInt(*r.ParentID, 10)
	}
	return map[string]any{
		"id":        strconv.FormatInt(r.ID, 10),
		"libraryId": strconv.FormatInt(r.LibraryID, 10),
		"parentId":  parentID,
		"name":      r.Name,
		"sortOrder": r.SortOrder,
		"createdAt": httpx.FormatISO(r.CreatedAt),
		"updatedAt": httpx.FormatISO(r.UpdatedAt),
	}
}

type documentRow struct {
	ID          int64
	UserID      int64
	LibraryID   int64
	FolderID    *int64
	FileName    string
	Title       string
	FileType    string
	ContentType *string
	ObjectKey   string
	SizeBytes   *int64
	PageCount   *int32
	CharCount   *int32
	Status      string
	BlocksJSON  *string
	Summary     *string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

const documentColumns = `id, user_id, library_id, folder_id, file_name, title, file_type, content_type,
	object_key, size_bytes, page_count, char_count, status, blocks_json, summary, created_at, updated_at`

func scanDocument(row pgx.Row) (*documentRow, error) {
	var d documentRow
	err := row.Scan(&d.ID, &d.UserID, &d.LibraryID, &d.FolderID, &d.FileName, &d.Title, &d.FileType,
		&d.ContentType, &d.ObjectKey, &d.SizeBytes, &d.PageCount, &d.CharCount, &d.Status,
		&d.BlocksJSON, &d.Summary, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func flexIDString(v *int64) any {
	if v == nil {
		return nil
	}
	return strconv.FormatInt(*v, 10)
}

func (d *documentRow) toListItem() map[string]any {
	return map[string]any{
		"id":          strconv.FormatInt(d.ID, 10),
		"libraryId":   strconv.FormatInt(d.LibraryID, 10),
		"folderId":    flexIDString(d.FolderID),
		"fileName":    d.FileName,
		"title":       d.Title,
		"fileType":    d.FileType,
		"contentType": d.ContentType,
		"objectKey":   d.ObjectKey,
		"sizeBytes":   d.SizeBytes,
		"pageCount":   d.PageCount,
		"status":      d.Status,
		"createdAt":   httpx.FormatISO(d.CreatedAt),
		"updatedAt":   httpx.FormatISO(d.UpdatedAt),
	}
}

type chunkRow struct {
	ChunkIndex int32
	Page       *int32
	Locator    *string
	Text       string
}

// parseJsonArray 对应 parseJsonArray：损坏数据一律回退空数组。
func parseJsonArray(raw *string) []any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []any{}
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return []any{}
	}
	if arr, ok := parsed.([]any); ok {
		return arr
	}
	return []any{}
}

// ===== 文档库 CRUD =====

// GetLibraryOrThrow 按 user 过滤读取文档库，不存在返回 404。
func GetLibraryOrThrow(ctx context.Context, userID, libraryID int64) (*libraryRow, error) {
	r, err := scanLibrary(db.Pool().QueryRow(ctx,
		`SELECT `+libraryColumns+` FROM petrichor_doc_library WHERE id = $1 AND user_id = $2 LIMIT 1`,
		libraryID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("文档库不存在")
	}
	return r, err
}

// ListLibraries 文档库列表（读穿透缓存）。
func ListLibraries(ctx context.Context, userID int64) ([]map[string]any, error) {
	return cache.ReadThrough(docLibraryListKey(userID), cache.OneDaySeconds, func() ([]map[string]any, error) {
		rows, err := db.Pool().Query(ctx,
			`SELECT `+libraryColumns+` FROM petrichor_doc_library WHERE user_id = $1
			 ORDER BY updated_at DESC, id DESC`, userID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		list := []map[string]any{}
		for rows.Next() {
			r, serr := scanLibrary(rows)
			if serr != nil {
				return nil, serr
			}
			list = append(list, r.toResponse())
		}
		return list, rows.Err()
	})
}

// SaveLibraryInput 新建/更新文档库入参（已校验）。
type SaveLibraryInput struct {
	ID          *int64
	Name        string
	Description *string
	Color       *string
	Icon        *string
}

// SaveLibrary 新建或更新文档库，返回字符串化 ID。
func SaveLibrary(ctx context.Context, userID int64, input SaveLibraryInput) (string, error) {
	pool := db.Pool()
	now := time.Now()
	var id int64
	if input.ID != nil {
		if _, err := GetLibraryOrThrow(ctx, userID, *input.ID); err != nil {
			return "", err
		}
		err := pool.QueryRow(ctx,
			`UPDATE petrichor_doc_library SET name = $1, description = $2, color = $3, icon = $4, updated_at = $5
			 WHERE id = $6 AND user_id = $7 RETURNING id`,
			input.Name, input.Description, input.Color, input.Icon, now, *input.ID, userID).Scan(&id)
		if err != nil {
			return "", err
		}
		invalidateDocLibraryCache(userID)
		return strconv.FormatInt(id, 10), nil
	}
	err := pool.QueryRow(ctx,
		`INSERT INTO petrichor_doc_library
		 (user_id, name, description, color, icon, document_count, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, 0, $6, $6) RETURNING id`,
		userID, input.Name, input.Description, input.Color, input.Icon, now).Scan(&id)
	if err != nil {
		return "", err
	}
	invalidateDocLibraryCache(userID)
	return strconv.FormatInt(id, 10), nil
}

// DeleteLibrary 级联删除库及其文件夹/文档/分块，并清理对象存储。
func DeleteLibrary(ctx context.Context, userID, libraryID int64) (map[string]any, error) {
	if _, err := GetLibraryOrThrow(ctx, userID, libraryID); err != nil {
		return nil, err
	}
	docRows, err := db.Pool().Query(ctx,
		`SELECT object_key FROM petrichor_doc_document WHERE library_id = $1 AND user_id = $2`,
		libraryID, userID)
	if err != nil {
		return nil, err
	}
	objectKeys := []string{}
	for docRows.Next() {
		var key string
		if serr := docRows.Scan(&key); serr != nil {
			docRows.Close()
			return nil, serr
		}
		objectKeys = append(objectKeys, key)
	}
	docRows.Close()
	if err := docRows.Err(); err != nil {
		return nil, err
	}

	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`DELETE FROM petrichor_doc_chunk WHERE library_id = $1`, []any{libraryID}},
		{`DELETE FROM petrichor_doc_document WHERE library_id = $1`, []any{libraryID}},
		{`DELETE FROM petrichor_doc_folder WHERE library_id = $1`, []any{libraryID}},
		{`DELETE FROM petrichor_doc_library WHERE id = $1 AND user_id = $2`, []any{libraryID, userID}},
	} {
		if _, cerr := tx.Exec(ctx, stmt.sql, stmt.args...); cerr != nil {
			return nil, cerr
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	storageCleanup := cleanupDocumentObjectKeys(userID, objectKeys)
	invalidateDocLibraryCache(userID)
	return map[string]any{
		"id":             strconv.FormatInt(libraryID, 10),
		"storageCleanup": storageCleanup,
	}, nil
}

// ===== 文件夹 =====

// ListFolders 文件夹列表（读穿透缓存）。
func ListFolders(ctx context.Context, userID, libraryID int64) ([]map[string]any, error) {
	return cache.ReadThrough(docFolderListKey(userID, libraryID), cache.OneDaySeconds, func() ([]map[string]any, error) {
		rows, err := db.Pool().Query(ctx,
			`SELECT `+folderColumns+` FROM petrichor_doc_folder WHERE user_id = $1 AND library_id = $2
			 ORDER BY sort_order ASC, id ASC`, userID, libraryID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		list := []map[string]any{}
		for rows.Next() {
			var r folderRow
			if serr := rows.Scan(&r.ID, &r.UserID, &r.LibraryID, &r.ParentID, &r.Name,
				&r.SortOrder, &r.CreatedAt, &r.UpdatedAt); serr != nil {
				return nil, serr
			}
			list = append(list, r.toResponse())
		}
		return list, rows.Err()
	})
}

// SaveFolderInput 新建/更新文件夹入参（已校验）。
type SaveFolderInput struct {
	ID       *int64
	Name     string
	ParentID *int64
}

// SaveFolder 新建或更新文件夹。更新时仅改名称与父级，不迁移所属库。
func SaveFolder(ctx context.Context, userID, libraryID int64, input SaveFolderInput) (string, error) {
	if _, err := GetLibraryOrThrow(ctx, userID, libraryID); err != nil {
		return "", err
	}
	now := time.Now()
	var id int64
	if input.ID != nil {
		err := db.Pool().QueryRow(ctx,
			`UPDATE petrichor_doc_folder SET name = $1, parent_id = $2, updated_at = $3
			 WHERE id = $4 AND user_id = $5 RETURNING id`,
			input.Name, input.ParentID, now, *input.ID, userID).Scan(&id)
		if err != nil {
			return "", err
		}
		invalidateDocLibraryCache(userID)
		return strconv.FormatInt(id, 10), nil
	}
	err := db.Pool().QueryRow(ctx,
		`INSERT INTO petrichor_doc_folder (user_id, library_id, parent_id, name, sort_order, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, 0, $5, $5) RETURNING id`,
		userID, libraryID, input.ParentID, input.Name, now).Scan(&id)
	if err != nil {
		return "", err
	}
	invalidateDocLibraryCache(userID)
	return strconv.FormatInt(id, 10), nil
}

// DeleteFolder 删除文件夹：其中文档归位根目录，子文件夹由外键级联处理。
func DeleteFolder(ctx context.Context, userID, folderID int64) (map[string]any, error) {
	pool := db.Pool()
	if _, err := pool.Exec(ctx,
		`UPDATE petrichor_doc_document SET folder_id = NULL WHERE user_id = $1 AND folder_id = $2`,
		userID, folderID); err != nil {
		return nil, err
	}
	if _, err := pool.Exec(ctx,
		`DELETE FROM petrichor_doc_folder WHERE id = $1 AND user_id = $2`, folderID, userID); err != nil {
		return nil, err
	}
	invalidateDocLibraryCache(userID)
	return map[string]any{"id": strconv.FormatInt(folderID, 10)}, nil
}

// ===== 文档 =====

// ChunkInput 登记文档时分块入参（已清洗）。
type ChunkInput struct {
	Text    string
	Page    *int32
	Locator *string
}

// RegisterDocumentInput 登记文档入参（已校验）。
type RegisterDocumentInput struct {
	LibraryID   int64
	FolderID    *int64
	FileName    string
	Title       *string
	FileType    string
	ContentType *string
	ObjectKey   string
	SizeBytes   *int64
	PageCount   *int32
	Blocks      []json.RawMessage
	Chunks      []ChunkInput
	Summary     *string
}

func runeSlice(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	runes := []rune(s)
	return string(runes[:max])
}

// RegisterDocument 把客户端已上传的文件登记入库：文档 + 分块 + 库计数，事务内完成。
func RegisterDocument(ctx context.Context, userID int64, input RegisterDocumentInput) (map[string]any, error) {
	if _, err := GetLibraryOrThrow(ctx, userID, input.LibraryID); err != nil {
		return nil, err
	}

	// 清洗分块：折叠空白、截断、去空、限量
	cleanChunks := make([]ChunkInput, 0, len(input.Chunks))
	for _, chunk := range input.Chunks {
		text := runeSlice(strings.TrimSpace(whitespacePattern.ReplaceAllString(chunk.Text, " ")), MaxChunkChars)
		if text == "" {
			continue
		}
		cleanChunks = append(cleanChunks, ChunkInput{Text: text, Page: chunk.Page, Locator: chunk.Locator})
		if len(cleanChunks) >= MaxChunks {
			break
		}
	}
	charCount := 0
	for _, chunk := range cleanChunks {
		charCount += utf8.RuneCountInString(chunk.Text)
	}
	hasBlocks := len(input.Blocks) > 0
	now := time.Now()

	title := ""
	if input.Title != nil {
		title = strings.TrimSpace(*input.Title)
	}
	if title == "" {
		title = input.FileName
	}
	title = runeSlice(title, 255)

	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var blocksArg any
	if hasBlocks {
		raw, merr := json.Marshal(input.Blocks)
		if merr != nil {
			return nil, merr
		}
		blocksArg = string(raw)
	}

	var documentID int64
	err = tx.QueryRow(ctx,
		`INSERT INTO petrichor_doc_document
		 (user_id, library_id, folder_id, file_name, title, file_type, content_type, object_key,
		  size_bytes, page_count, char_count, status, blocks_json, summary, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'ready',$12,$13,$14,$14) RETURNING id`,
		userID, input.LibraryID, input.FolderID, input.FileName, title, input.FileType,
		input.ContentType, input.ObjectKey, input.SizeBytes, input.PageCount, charCount,
		blocksArg, input.Summary, now).Scan(&documentID)
	if err != nil {
		return nil, err
	}

	if len(cleanChunks) > 0 {
		batch := &pgx.Batch{}
		for index, chunk := range cleanChunks {
			batch.Queue(
				`INSERT INTO petrichor_doc_chunk
				 (user_id, library_id, document_id, chunk_index, locator, page, text, created_at)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				userID, input.LibraryID, documentID, int32(index), chunk.Locator, chunk.Page, chunk.Text, now)
		}
		if brerr := tx.SendBatch(ctx, batch).Close(); brerr != nil {
			return nil, brerr
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE petrichor_doc_library SET document_count = document_count + 1, updated_at = $1
		 WHERE id = $2 AND user_id = $3`, now, input.LibraryID, userID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	invalidateDocLibraryCache(userID)
	return map[string]any{"id": strconv.FormatInt(documentID, 10)}, nil
}

// ListDocuments 库内文档列表（读穿透缓存）。
func ListDocuments(ctx context.Context, userID, libraryID int64) ([]map[string]any, error) {
	return cache.ReadThrough(docDocumentListKey(userID, libraryID), cache.OneDaySeconds, func() ([]map[string]any, error) {
		rows, err := db.Pool().Query(ctx,
			`SELECT `+documentColumns+` FROM petrichor_doc_document
			 WHERE user_id = $1 AND library_id = $2
			 ORDER BY created_at DESC, id DESC`, userID, libraryID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		list := []map[string]any{}
		for rows.Next() {
			d, serr := scanDocument(rows)
			if serr != nil {
				return nil, serr
			}
			list = append(list, d.toListItem())
		}
		return list, rows.Err()
	})
}

// GetDocumentOrThrow 按 user 过滤读取文档，不存在返回 404。
func GetDocumentOrThrow(ctx context.Context, userID, documentID int64) (*documentRow, error) {
	d, err := scanDocument(db.Pool().QueryRow(ctx,
		`SELECT `+documentColumns+` FROM petrichor_doc_document WHERE id = $1 AND user_id = $2 LIMIT 1`,
		documentID, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, httpx.NotFound("文档不存在")
	}
	return d, err
}

// GetDocumentDetail 文档详情（含分块，读穿透缓存）。
func GetDocumentDetail(ctx context.Context, userID, documentID int64) (map[string]any, error) {
	key := docDocumentDetailKey(userID, documentID)
	return cache.ReadThrough(key, cache.OneDaySeconds, func() (map[string]any, error) {
		doc, err := GetDocumentOrThrow(ctx, userID, documentID)
		if err != nil {
			return nil, err
		}
		rows, err := db.Pool().Query(ctx,
			`SELECT chunk_index, page, locator, text FROM petrichor_doc_chunk
			 WHERE document_id = $1 AND user_id = $2 ORDER BY chunk_index ASC`, documentID, userID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		chunks := []map[string]any{}
		for rows.Next() {
			var cr chunkRow
			if serr := rows.Scan(&cr.ChunkIndex, &cr.Page, &cr.Locator, &cr.Text); serr != nil {
				return nil, serr
			}
			chunks = append(chunks, map[string]any{
				"chunkIndex": cr.ChunkIndex,
				"page":       cr.Page,
				"locator":    cr.Locator,
				"text":       cr.Text,
			})
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}

		item := doc.toListItem()
		item["charCount"] = doc.CharCount
		item["blocks"] = parseJsonArray(doc.BlocksJSON)
		item["chunks"] = chunks
		item["summary"] = doc.Summary
		return item, nil
	})
}

// DeleteDocument 删除文档及其分块，回减库计数并清理对象存储。
func DeleteDocument(ctx context.Context, userID, documentID int64) (map[string]any, error) {
	doc, err := GetDocumentOrThrow(ctx, userID, documentID)
	if err != nil {
		return nil, err
	}
	tx, err := db.Pool().Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM petrichor_doc_chunk WHERE document_id = $1`, documentID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`DELETE FROM petrichor_doc_document WHERE id = $1 AND user_id = $2`, documentID, userID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE petrichor_doc_library
		 SET document_count = CASE WHEN document_count > 0 THEN document_count - 1 ELSE 0 END, updated_at = $1
		 WHERE id = $2 AND user_id = $3`, time.Now(), doc.LibraryID, userID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	storageCleanup := cleanupDocumentObjectKeys(userID, []string{doc.ObjectKey})
	invalidateDocLibraryCache(userID)
	return map[string]any{
		"id":             strconv.FormatInt(documentID, 10),
		"objectKey":      doc.ObjectKey,
		"storageCleanup": storageCleanup,
	}, nil
}

var _ = slog.Default // 保持 slog 引用对齐
