// handlers.go 文档库 HTTP 层：鉴权由路由中间件完成，这里做入参校验与响应包装。
package doclibrary

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"petrichor/api/internal/auth"
	httpx "petrichor/api/internal/httpx"
)

// FlexOptionalID 对应 optionalIdSchema：字符串/数字/空值均可；
// 空串或非纯数字静默归为 null，其余 JSON 类型报错。
type FlexOptionalID struct {
	Value *int64
}

func (f *FlexOptionalID) setDigits(raw string) {
	t := strings.TrimSpace(raw)
	if t == "" || !isDigitString(t) {
		f.Value = nil
		return
	}
	n, err := strconv.ParseInt(t, 10, 64)
	if err != nil {
		f.Value = nil
		return
	}
	value := n
	f.Value = &value
}

func (f *FlexOptionalID) UnmarshalJSON(data []byte) error {
	s := strings.TrimSpace(string(data))
	switch {
	case s == "" || s == "null":
		f.Value = nil
	case strings.HasPrefix(s, `"`):
		unquoted, err := strconv.Unquote(s)
		if err != nil {
			return httpx.BadRequest("ID 必须是正整数")
		}
		f.setDigits(unquoted)
	case s[0] == '-' || (s[0] >= '0' && s[0] <= '9'):
		f.setDigits(s)
	default:
		return httpx.BadRequest("ID 必须是正整数")
	}
	return nil
}

func isDigitString(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// requireFlexID 必填 ID 校验（字段缺失或非法均拒绝）。
func requireFlexID(v httpx.FlexID, label string) (int64, error) {
	if v <= 0 {
		return 0, httpx.BadRequest(label + " 必须是正整数")
	}
	return int64(v), nil
}

func runeLen(s string) int { return len([]rune(s)) }

func trimmedPtr(v *string, maxLength int, label string) (*string, error) {
	if v == nil {
		return nil, nil
	}
	t := strings.TrimSpace(*v)
	if runeLen(t) > maxLength {
		return nil, httpx.BadRequest(label + "长度不能超过 " + strconv.Itoa(maxLength))
	}
	return &t, nil
}

func badRequest(c *gin.Context, msg string) {
	httpx.ErrorJSON(c, 400, msg)
}

// ===== library =====

type librarySaveRequest struct {
	ID          FlexOptionalID `json:"id"`
	Name        string         `json:"name"`
	Description *string        `json:"description"`
	Color       *string        `json:"color"`
	Icon        *string        `json:"icon"`
}

// ListLibrariesHandler GET /api/doc-library/library/list。
func ListLibrariesHandler(c *gin.Context) {
	user := auth.CurrentUser(c)
	libraries, err := ListLibraries(c.Request.Context(), user.ID)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, gin.H{"libraries": libraries})
}

// SaveLibraryHandler POST /api/doc-library/library/save。
func SaveLibraryHandler(c *gin.Context) {
	var req librarySaveRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		badRequest(c, "名称不能为空")
		return
	}
	if runeLen(name) > 80 {
		badRequest(c, "名称长度不能超过 80")
		return
	}
	description, err := trimmedPtr(req.Description, 500, "描述")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	color, err := trimmedPtr(req.Color, 40, "颜色")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	icon, err := trimmedPtr(req.Icon, 40, "图标")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}

	user := auth.CurrentUser(c)
	id, serr := SaveLibrary(c.Request.Context(), user.ID, SaveLibraryInput{
		ID:          req.ID.Value,
		Name:        name,
		Description: description,
		Color:       color,
		Icon:        icon,
	})
	if serr != nil {
		httpx.HandleError(c, serr)
		return
	}
	httpx.OK(c, gin.H{"id": id})
}

// DeleteLibraryHandler POST /api/doc-library/library/delete。
func DeleteLibraryHandler(c *gin.Context) {
	var req struct {
		ID httpx.FlexID `json:"id"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	id, err := requireFlexID(req.ID, "id")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := auth.CurrentUser(c)
	result, derr := DeleteLibrary(c.Request.Context(), user.ID, id)
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	httpx.OK(c, result)
}

// ===== folder =====

type folderSaveRequest struct {
	ID        FlexOptionalID `json:"id"`
	LibraryID httpx.FlexID   `json:"libraryId"`
	ParentID  FlexOptionalID `json:"parentId"`
	Name      string         `json:"name"`
}

// SaveFolderHandler POST /api/doc-library/folder/save。
func SaveFolderHandler(c *gin.Context) {
	var req folderSaveRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	libraryID, err := requireFlexID(req.LibraryID, "libraryId")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		badRequest(c, "名称不能为空")
		return
	}
	if runeLen(name) > 120 {
		badRequest(c, "名称长度不能超过 120")
		return
	}

	user := auth.CurrentUser(c)
	id, serr := SaveFolder(c.Request.Context(), user.ID, libraryID, SaveFolderInput{
		ID:       req.ID.Value,
		Name:     name,
		ParentID: req.ParentID.Value,
	})
	if serr != nil {
		httpx.HandleError(c, serr)
		return
	}
	httpx.OK(c, gin.H{"id": id})
}

// ListFoldersHandler POST /api/doc-library/folder/list。
func ListFoldersHandler(c *gin.Context) {
	var req struct {
		LibraryID httpx.FlexID `json:"libraryId"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	libraryID, err := requireFlexID(req.LibraryID, "libraryId")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := auth.CurrentUser(c)
	folders, ferr := ListFolders(c.Request.Context(), user.ID, libraryID)
	if ferr != nil {
		httpx.HandleError(c, ferr)
		return
	}
	httpx.OK(c, gin.H{"folders": folders})
}

// DeleteFolderHandler POST /api/doc-library/folder/delete。
func DeleteFolderHandler(c *gin.Context) {
	var req struct {
		ID httpx.FlexID `json:"id"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	id, err := requireFlexID(req.ID, "id")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := auth.CurrentUser(c)
	result, derr := DeleteFolder(c.Request.Context(), user.ID, id)
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	httpx.OK(c, result)
}

// ===== document =====

type chunkRequest struct {
	Text    string  `json:"text"`
	Page    *int32  `json:"page"`
	Locator *string `json:"locator"`
}

type documentRegisterRequest struct {
	LibraryID   httpx.FlexID      `json:"libraryId"`
	FolderID    FlexOptionalID    `json:"folderId"`
	FileName    string            `json:"fileName"`
	Title       *string           `json:"title"`
	FileType    string            `json:"fileType"`
	ContentType *string           `json:"contentType"`
	ObjectKey   string            `json:"objectKey"`
	SizeBytes   *int64            `json:"sizeBytes"`
	PageCount   *int32            `json:"pageCount"`
	Blocks      []json.RawMessage `json:"blocks"`
	Chunks      []chunkRequest    `json:"chunks"`
	Summary     *string           `json:"summary"`
}

// RegisterDocumentHandler POST /api/doc-library/document/register。
// 客户端已完成解析与上传，这里只负责把结果登记入库。
func RegisterDocumentHandler(c *gin.Context) {
	var req documentRegisterRequest
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	libraryID, err := requireFlexID(req.LibraryID, "libraryId")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	fileName := strings.TrimSpace(req.FileName)
	if fileName == "" || runeLen(fileName) > 255 {
		badRequest(c, "fileName 长度必须在 1 到 255 之间")
		return
	}
	title, terr := trimmedPtr(req.Title, 255, "标题")
	if terr != nil {
		httpx.HandleError(c, terr)
		return
	}
	fileType := strings.ToLower(strings.TrimSpace(req.FileType))
	if _, ok := FileTypes[fileType]; !ok {
		badRequest(c, "仅支持 PDF / docx / xlsx / csv")
		return
	}
	contentType, cerr := trimmedPtr(req.ContentType, 160, "contentType")
	if cerr != nil {
		httpx.HandleError(c, cerr)
		return
	}
	objectKey := strings.TrimSpace(req.ObjectKey)
	if objectKey == "" || runeLen(objectKey) > 512 {
		badRequest(c, "objectKey 长度必须在 1 到 512 之间")
		return
	}
	if req.SizeBytes != nil && *req.SizeBytes < 0 {
		badRequest(c, "sizeBytes 不能为负数")
		return
	}
	if req.PageCount != nil && *req.PageCount < 0 {
		badRequest(c, "pageCount 不能为负数")
		return
	}
	if len(req.Chunks) > MaxChunks {
		badRequest(c, "分块数量不能超过 "+strconv.Itoa(MaxChunks))
		return
	}
	chunks := make([]ChunkInput, 0, len(req.Chunks))
	for _, chunk := range req.Chunks {
		if chunk.Page != nil && *chunk.Page < 0 {
			badRequest(c, "分块 page 不能为负数")
			return
		}
		locator, lerr := trimmedPtr(chunk.Locator, 80, "分块 locator")
		if lerr != nil {
			httpx.HandleError(c, lerr)
			return
		}
		chunks = append(chunks, ChunkInput{Text: chunk.Text, Page: chunk.Page, Locator: locator})
	}
	summary, sumErr := trimmedPtr(req.Summary, 2000, "摘要")
	if sumErr != nil {
		httpx.HandleError(c, sumErr)
		return
	}

	user := auth.CurrentUser(c)
	result, rerr := RegisterDocument(c.Request.Context(), user.ID, RegisterDocumentInput{
		LibraryID:   libraryID,
		FolderID:    req.FolderID.Value,
		FileName:    fileName,
		Title:       title,
		FileType:    fileType,
		ContentType: contentType,
		ObjectKey:   objectKey,
		SizeBytes:   req.SizeBytes,
		PageCount:   req.PageCount,
		Blocks:      req.Blocks,
		Chunks:      chunks,
		Summary:     summary,
	})
	if rerr != nil {
		httpx.HandleError(c, rerr)
		return
	}
	httpx.OK(c, result)
}

// ListDocumentsHandler POST /api/doc-library/document/list。
func ListDocumentsHandler(c *gin.Context) {
	var req struct {
		LibraryID httpx.FlexID `json:"libraryId"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	libraryID, err := requireFlexID(req.LibraryID, "libraryId")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := auth.CurrentUser(c)
	documents, derr := ListDocuments(c.Request.Context(), user.ID, libraryID)
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	httpx.OK(c, gin.H{"documents": documents})
}

// DocumentDetailHandler POST /api/doc-library/document/detail。
func DocumentDetailHandler(c *gin.Context) {
	var req struct {
		ID httpx.FlexID `json:"id"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	id, err := requireFlexID(req.ID, "id")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := auth.CurrentUser(c)
	document, derr := GetDocumentDetail(c.Request.Context(), user.ID, id)
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	httpx.OK(c, gin.H{"document": document})
}

// DeleteDocumentHandler POST /api/doc-library/document/delete。
func DeleteDocumentHandler(c *gin.Context) {
	var req struct {
		ID httpx.FlexID `json:"id"`
	}
	if err := httpx.ReadJSON(c, &req); err != nil {
		httpx.HandleError(c, err)
		return
	}
	id, err := requireFlexID(req.ID, "id")
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	user := auth.CurrentUser(c)
	result, derr := DeleteDocument(c.Request.Context(), user.ID, id)
	if derr != nil {
		httpx.HandleError(c, derr)
		return
	}
	// 与 TS 路由一致：只回传 id 与清理摘要，不暴露 objectKey
	httpx.OK(c, gin.H{"id": result["id"], "storageCleanup": result["storageCleanup"]})
}
