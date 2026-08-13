package kb

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentchunk"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumentfolder"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocumenttag"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/upload"
)

var supportedKBDocumentTypes = map[string]struct{}{
	"md": {}, "markdown": {}, "pdf": {}, "docx": {}, "xlsx": {}, "xls": {}, "csv": {}, "tsv": {},
}

func (h *Handler) DocumentFolderList(c *gin.Context) {
	var req idRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	rows, err := h.svc.client.KBDocumentFolder.Query().Where(
		kbdocumentfolder.UserIDEQ(u.ID), kbdocumentfolder.KnowledgeBaseIDEQ(kbID),
	).Order(ent.Asc(kbdocumentfolder.FieldSortOrder), ent.Asc(kbdocumentfolder.FieldID)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		item := gin.H{
			"id": fmt.Sprintf("%d", row.ID), "knowledgeBaseId": fmt.Sprintf("%d", row.KnowledgeBaseID),
			"parentId": nil, "name": row.Name, "sortOrder": row.SortOrder,
			"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano), "updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		}
		if row.ParentID != nil {
			item["parentId"] = fmt.Sprintf("%d", *row.ParentID)
		}
		items = append(items, item)
	}
	response.OK(c, gin.H{"folders": items})
}

func (h *Handler) DocumentFolderSave(c *gin.Context) {
	var req struct {
		ID              string  `json:"id"`
		KnowledgeBaseID string  `json:"knowledgeBaseId" binding:"required"`
		ParentID        *string `json:"parentId"`
		Name            string  `json:"name" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len([]rune(name)) > 120 {
		response.Fail(c, response.BadRequest("文件夹名称不能为空且不能超过 120 个字符"))
		return
	}
	var parentID *int64
	if req.ParentID != nil && strings.TrimSpace(*req.ParentID) != "" {
		value, err := parsePositiveID(*req.ParentID, "parentId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		exists, err := h.svc.client.KBDocumentFolder.Query().Where(
			kbdocumentfolder.IDEQ(value), kbdocumentfolder.UserIDEQ(u.ID), kbdocumentfolder.KnowledgeBaseIDEQ(kbID),
		).Exist(c.Request.Context())
		if err != nil || !exists {
			if err == nil {
				err = response.BadRequest("父文件夹不存在")
			}
			response.Fail(c, err)
			return
		}
		parentID = &value
	}
	if strings.TrimSpace(req.ID) == "" {
		builder := h.svc.client.KBDocumentFolder.Create().SetUserID(u.ID).SetKnowledgeBaseID(kbID).SetName(name)
		if parentID != nil {
			builder.SetParentID(*parentID)
		}
		row, err := builder.Save(c.Request.Context())
		if err != nil {
			response.Fail(c, err)
			return
		}
		response.OK(c, gin.H{"id": fmt.Sprintf("%d", row.ID)})
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	if parentID != nil && *parentID == id {
		response.Fail(c, response.BadRequest("父文件夹不能是自身"))
		return
	}
	if parentID != nil {
		// 防止把目录移动到自己的任意后代目录，避免形成无法遍历的环。
		currentID := parentID
		visited := map[int64]struct{}{}
		for currentID != nil {
			if *currentID == id {
				response.Fail(c, response.BadRequest("父文件夹不能是当前文件夹的子目录"))
				return
			}
			if _, exists := visited[*currentID]; exists {
				response.Fail(c, response.BadRequest("目录层级存在循环引用"))
				return
			}
			visited[*currentID] = struct{}{}
			ancestor, err := h.svc.client.KBDocumentFolder.Query().Where(
				kbdocumentfolder.IDEQ(*currentID), kbdocumentfolder.UserIDEQ(u.ID), kbdocumentfolder.KnowledgeBaseIDEQ(kbID),
			).Only(c.Request.Context())
			if err != nil {
				response.Fail(c, err)
				return
			}
			currentID = ancestor.ParentID
		}
	}
	update := h.svc.client.KBDocumentFolder.Update().Where(
		kbdocumentfolder.IDEQ(id), kbdocumentfolder.UserIDEQ(u.ID), kbdocumentfolder.KnowledgeBaseIDEQ(kbID),
	).SetName(name)
	if parentID == nil {
		update.ClearParentID()
	} else {
		update.SetParentID(*parentID)
	}
	n, err := update.Save(c.Request.Context())
	if err != nil || n == 0 {
		if err == nil {
			err = response.NotFound("文件夹不存在")
		}
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"id": req.ID})
}

func (h *Handler) DocumentFolderDelete(c *gin.Context) {
	var req struct {
		ID        string `json:"id" binding:"required"`
		Recursive bool   `json:"recursive"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.client.KBDocumentFolder.Query().Where(kbdocumentfolder.IDEQ(id), kbdocumentfolder.UserIDEQ(u.ID)).Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			err = response.NotFound("文件夹不存在")
		}
		response.Fail(c, err)
		return
	}
	childFolders, err := h.svc.client.KBDocumentFolder.Query().Where(kbdocumentfolder.ParentIDEQ(id), kbdocumentfolder.UserIDEQ(u.ID)).Count(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	childDocuments, err := h.svc.client.KBDocument.Query().Where(kbdocument.FolderIDEQ(id), kbdocument.UserIDEQ(u.ID)).Count(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if (childFolders > 0 || childDocuments > 0) && !req.Recursive {
		response.Fail(c, response.BadRequest("目录非空，请先移动内容或确认递归删除"))
		return
	}
	if _, err := h.svc.client.KBDocument.Update().Where(kbdocument.FolderIDEQ(id), kbdocument.UserIDEQ(u.ID)).ClearFolderID().Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	if _, err := h.svc.client.KBDocumentFolder.Update().Where(
		kbdocumentfolder.ParentIDEQ(id), kbdocumentfolder.UserIDEQ(u.ID),
	).ClearParentID().Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	if err := h.svc.client.KBDocumentFolder.DeleteOne(row).Exec(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"id": req.ID, "movedDocuments": childDocuments, "movedFolders": childFolders})
}

func (h *Handler) DocumentList(c *gin.Context) {
	var req idRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	rows, err := h.svc.client.KBDocument.Query().Where(
		kbdocument.UserIDEQ(u.ID), kbdocument.KnowledgeBaseIDEQ(kbID),
	).Order(ent.Desc(kbdocument.FieldUpdatedAt), ent.Desc(kbdocument.FieldID)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	tagRows, err := h.svc.client.KBDocumentTag.Query().Where(
		kbdocumenttag.UserIDEQ(u.ID), kbdocumenttag.KnowledgeBaseIDEQ(kbID),
	).Order(ent.Asc(kbdocumenttag.FieldTag)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	tagsByDocument := map[int64][]string{}
	for _, tag := range tagRows {
		tagsByDocument[tag.DocumentID] = append(tagsByDocument[tag.DocumentID], tag.Tag)
	}
	items := make([]gin.H, 0, len(rows))
	for _, row := range rows {
		item := kbDocumentDTO(row)
		item["tags"] = tagsByDocument[row.ID]
		items = append(items, item)
	}
	response.OK(c, gin.H{"documents": items})
}

func (h *Handler) DocumentRegister(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string               `json:"knowledgeBaseId" binding:"required"`
		FolderID        *string              `json:"folderId"`
		Title           *string              `json:"title"`
		FileName        string               `json:"fileName" binding:"required"`
		FileType        string               `json:"fileType" binding:"required"`
		ObjectKey       string               `json:"objectKey" binding:"required"`
		ContentType     *string              `json:"contentType"`
		SizeBytes       *int64               `json:"sizeBytes"`
		PageCount       *int                 `json:"pageCount"`
		Blocks          []any                `json:"blocks"`
		ExtractedText   *string              `json:"extractedText"`
		Segments        []kbTextSegmentInput `json:"segments"`
		Summary         *string              `json:"summary"`
		// ParseConfig 是本次上传的解析配置，省略时全部沿用知识库默认值。
		ParseConfig *DocumentParseConfig `json:"parseConfig"`
		// PageImages 是浏览器栅格化后直传对象存储的整页图片，供多模态识别阶段使用。
		PageImages []documentPageImage `json:"pageImages"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	fileType := strings.ToLower(strings.TrimSpace(req.FileType))
	if _, ok := supportedKBDocumentTypes[fileType]; !ok {
		response.Fail(c, response.BadRequest("仅支持 Markdown / PDF / Word / Excel / CSV"))
		return
	}
	fileName, objectKey := strings.TrimSpace(req.FileName), strings.TrimSpace(req.ObjectKey)
	if fileName == "" || len([]rune(fileName)) > 255 || objectKey == "" || len([]rune(objectKey)) > 512 {
		response.Fail(c, response.BadRequest("文件名或对象键无效"))
		return
	}
	var folderID *int64
	if req.FolderID != nil && strings.TrimSpace(*req.FolderID) != "" {
		value, err := parsePositiveID(*req.FolderID, "folderId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		exists, err := h.svc.client.KBDocumentFolder.Query().Where(
			kbdocumentfolder.IDEQ(value), kbdocumentfolder.UserIDEQ(u.ID), kbdocumentfolder.KnowledgeBaseIDEQ(kbID),
		).Exist(c.Request.Context())
		if err != nil || !exists {
			if err == nil {
				err = response.BadRequest("文件夹不存在")
			}
			response.Fail(c, err)
			return
		}
		folderID = &value
	}
	if _, err := h.svc.GetOwned(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	config := NormalizeDocumentParseConfig(req.ParseConfig)
	// 页面图片走请求体的顶层字段，但要跟着配置一起存库，重新解析才有得用。
	config.PageImages = normalizeDocumentPageImages(req.PageImages)

	title := fileName
	if req.Title != nil && strings.TrimSpace(*req.Title) != "" {
		title = strings.TrimSpace(*req.Title)
	}
	// 文档先以 pending 落库并立即返回，解析、向量化、多模态、问题生成都在后台跑。
	// 大 PDF 的多模态识别动辄几分钟，挂在请求上必然超时，也看不到中间进度。
	builder := h.svc.client.KBDocument.Create().SetUserID(u.ID).SetKnowledgeBaseID(kbID).SetFileName(fileName).
		SetTitle(title).SetFileType(fileType).SetObjectKey(objectKey).SetStatus("pending").
		SetParseAttempt(1)
	if raw := encodeDocumentParseConfig(config); raw != nil {
		builder.SetParseConfigJSON(*raw)
	}
	if folderID != nil {
		builder.SetFolderID(*folderID)
	}
	if req.ContentType != nil && strings.TrimSpace(*req.ContentType) != "" {
		builder.SetContentType(strings.TrimSpace(*req.ContentType))
	}
	if req.SizeBytes != nil {
		builder.SetSizeBytes(*req.SizeBytes)
	}
	if req.PageCount != nil {
		builder.SetPageCount(*req.PageCount)
	}
	if len(req.Blocks) > 0 {
		raw, marshalErr := json.Marshal(req.Blocks)
		if marshalErr != nil {
			response.Fail(c, response.BadRequest("blocks 格式错误"))
			return
		}
		builder.SetBlocksJSON(string(raw))
	}
	if req.Summary != nil && strings.TrimSpace(*req.Summary) != "" {
		builder.SetSummary(strings.TrimSpace(*req.Summary))
	}
	row, err := builder.Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if err := h.svc.replaceDocumentTags(c.Request.Context(), u.ID, kbID, row.ID, config.Tags); err != nil {
		h.svc.log.Warn("写入文档标签失败", zap.Int64("document_id", row.ID), zap.Error(err))
	}

	clientText := ""
	if req.ExtractedText != nil {
		clientText = *req.ExtractedText
	}
	h.svc.startDocumentPipeline(u.ID, row.ID, 1, pipelineInput{
		ClientText:     clientText,
		ClientSegments: req.Segments,
		PageImages:     config.PageImages,
	})
	response.OK(c, gin.H{"id": fmt.Sprintf("%d", row.ID), "attempt": 1, "status": "pending"})
}

// DocumentSpans 返回某次解析尝试的 span 树，前端据此渲染处理流水线。
func (h *Handler) DocumentSpans(c *gin.Context) {
	var req struct {
		ID      string `json:"id" binding:"required"`
		Attempt *int   `json:"attempt"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	attempt := 0
	if req.Attempt != nil {
		attempt = *req.Attempt
	}
	payload, err := h.svc.LoadDocumentSpans(c.Request.Context(), auth.MustUser(c).ID, id, attempt)
	if err != nil {
		if ent.IsNotFound(err) {
			err = response.NotFound("文件不存在")
		}
		response.Fail(c, err)
		return
	}
	response.OK(c, payload)
}

// ChunkQuestionAdd 给单个分片手工补一条辅助召回问题。
func (h *Handler) ChunkQuestionAdd(c *gin.Context) {
	var req struct {
		ChunkID  string `json:"chunkId" binding:"required"`
		Question string `json:"question" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	chunkID, err := parsePositiveID(req.ChunkID, "chunkId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	questions, err := h.svc.AddChunkQuestion(c.Request.Context(), auth.MustUser(c).ID, chunkID, req.Question)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"chunkId": req.ChunkID, "questions": questions})
}

// ChunkQuestionDelete 删除一条辅助召回问题，对应的向量一并消失。
func (h *Handler) ChunkQuestionDelete(c *gin.Context) {
	var req struct {
		ID string `json:"id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	chunkID, questions, err := h.svc.DeleteChunkQuestion(c.Request.Context(), auth.MustUser(c).ID, id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"chunkId": fmt.Sprintf("%d", chunkID), "questions": questions})
}

// ChunkQuestionRegenerate 只为这一个分片重新生成问题，不需要重解析整份文档。
func (h *Handler) ChunkQuestionRegenerate(c *gin.Context) {
	var req struct {
		ChunkID string `json:"chunkId" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	chunkID, err := parsePositiveID(req.ChunkID, "chunkId")
	if err != nil {
		response.Fail(c, err)
		return
	}
	questions, err := h.svc.RegenerateChunkQuestions(c.Request.Context(), auth.MustUser(c).ID, chunkID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"chunkId": req.ChunkID, "questions": questions})
}

// DocumentTagList 返回知识库里已用过的文档标签，供筛选与上传时选择。
func (h *Handler) DocumentTagList(c *gin.Context) {
	var req idRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	if err := h.svc.assertKBOwner(c.Request.Context(), u.ID, kbID); err != nil {
		response.Fail(c, err)
		return
	}
	rows, err := h.svc.client.KBDocumentTag.Query().Where(
		kbdocumenttag.UserIDEQ(u.ID), kbdocumenttag.KnowledgeBaseIDEQ(kbID),
	).Order(ent.Asc(kbdocumenttag.FieldTag)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	counts := map[string]int{}
	order := make([]string, 0, len(rows))
	for _, row := range rows {
		if _, ok := counts[row.Tag]; !ok {
			order = append(order, row.Tag)
		}
		counts[row.Tag]++
	}
	items := make([]gin.H, 0, len(order))
	for _, tag := range order {
		items = append(items, gin.H{"tag": tag, "count": counts[tag]})
	}
	response.OK(c, gin.H{"tags": items})
}

// DocumentTagSave 覆盖单个文档的标签集合。
func (h *Handler) DocumentTagSave(c *gin.Context) {
	var req struct {
		ID   string   `json:"id" binding:"required"`
		Tags []string `json:"tags"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.client.KBDocument.Query().Where(kbdocument.IDEQ(id), kbdocument.UserIDEQ(u.ID)).Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			err = response.NotFound("文件不存在")
		}
		response.Fail(c, err)
		return
	}
	tags := normalizeDocumentTags(req.Tags)
	if err := h.svc.replaceDocumentTags(c.Request.Context(), u.ID, row.KnowledgeBaseID, row.ID, tags); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"id": req.ID, "tags": tags})
}

// replaceDocumentTags 用给定集合整体替换文档标签。
func (s *Service) replaceDocumentTags(ctx context.Context, userID, kbID, documentID int64, tags []string) error {
	if _, err := s.client.KBDocumentTag.Delete().
		Where(kbdocumenttag.DocumentIDEQ(documentID)).Exec(ctx); err != nil {
		return err
	}
	for _, tag := range tags {
		err := s.client.KBDocumentTag.Create().
			SetUserID(userID).SetKnowledgeBaseID(kbID).SetDocumentID(documentID).SetTag(tag).Exec(ctx)
		if err != nil {
			return err
		}
	}
	return nil
}

// normalizeDocumentPageImages 过滤掉页号非法或没有对象键的项，并按页号升序。
func normalizeDocumentPageImages(pages []documentPageImage) []documentPageImage {
	out := make([]documentPageImage, 0, len(pages))
	seen := map[int]struct{}{}
	for _, page := range pages {
		key := strings.TrimSpace(page.ImageKey)
		if page.PageNo <= 0 || key == "" {
			continue
		}
		if _, ok := seen[page.PageNo]; ok {
			continue
		}
		seen[page.PageNo] = struct{}{}
		out = append(out, documentPageImage{PageNo: page.PageNo, ImageKey: key})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].PageNo < out[j].PageNo })
	return out
}

// DocumentRechunk 重新解析一份已上传的文件：尝试号 +1，重跑完整流水线。
//
// 正文、分段边界和解析配置都已随文件存库，所以不需要重新上传，也不需要
// 浏览器再解析一遍。只有多模态识别要用的页面图片必须由调用方重新提供
// （浏览器栅格化），没提供就跳过多模态阶段。
func (h *Handler) DocumentRechunk(c *gin.Context) {
	var req struct {
		ID string `json:"id" binding:"required"`
		// ParseConfig 省略时沿用上次解析的配置。
		ParseConfig *DocumentParseConfig `json:"parseConfig"`
		PageImages  []documentPageImage  `json:"pageImages"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	doc, err := h.svc.client.KBDocument.Query().Where(kbdocument.IDEQ(id), kbdocument.UserIDEQ(u.ID)).Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			err = response.NotFound("文件不存在")
		}
		response.Fail(c, err)
		return
	}
	if _, err := h.svc.GetOwned(c.Request.Context(), u.ID, doc.KnowledgeBaseID); err != nil {
		response.Fail(c, err)
		return
	}

	stored := decodeDocumentParseConfig(doc.ParseConfigJSON)
	config := stored
	if req.ParseConfig != nil {
		config = NormalizeDocumentParseConfig(req.ParseConfig)
	}
	// 请求带了新图片就用新的，否则沿用上传时存下来的——
	// 扫描件的正文全靠这些图片，丢了就只能重新上传。
	if images := normalizeDocumentPageImages(req.PageImages); len(images) > 0 {
		config.PageImages = images
	} else {
		config.PageImages = stored.PageImages
	}
	attempt := doc.ParseAttempt + 1
	update := doc.Update().SetStatus("pending").SetParseAttempt(attempt).ClearError()
	if raw := encodeDocumentParseConfig(config); raw != nil {
		update.SetParseConfigJSON(*raw)
	}
	if _, err := update.Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	if req.ParseConfig != nil {
		if err := h.svc.replaceDocumentTags(c.Request.Context(), u.ID, doc.KnowledgeBaseID, doc.ID, config.Tags); err != nil {
			h.svc.log.Warn("写入文档标签失败", zap.Int64("document_id", doc.ID), zap.Error(err))
		}
	}

	// 重解析时正文来自库里已保存的抽取结果，作为服务端解析失败时的兜底。
	clientText := ""
	if doc.ExtractedText != nil {
		clientText = *doc.ExtractedText
	}
	var segments []kbTextSegmentInput
	if doc.SegmentsJSON != nil {
		_ = json.Unmarshal([]byte(*doc.SegmentsJSON), &segments)
	}
	h.svc.startDocumentPipeline(u.ID, doc.ID, attempt, pipelineInput{
		ClientText:     clientText,
		ClientSegments: segments,
		PageImages:     config.PageImages,
	})
	response.OK(c, gin.H{"id": req.ID, "attempt": attempt, "status": "pending"})
}

func (h *Handler) DocumentEmbeddingRun(c *gin.Context) {
	var req struct {
		KnowledgeBaseID string  `json:"knowledgeBaseId" binding:"required"`
		DocumentID      *string `json:"documentId"`
		Rebuild         bool    `json:"rebuild"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	var documentID *int64
	if req.DocumentID != nil && strings.TrimSpace(*req.DocumentID) != "" {
		value, parseErr := parsePositiveID(*req.DocumentID, "documentId")
		if parseErr != nil {
			response.Fail(c, parseErr)
			return
		}
		documentID = &value
	}
	u := auth.MustUser(c)
	embedded, status, err := h.svc.EmbedKnowledgeBaseDocumentChunks(c.Request.Context(), u.ID, kbID, documentID, req.Rebuild)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"embedded": embedded, "status": status})
}

func (h *Handler) DocumentEmbeddingStatus(c *gin.Context) {
	var req idRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	kbID, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	status, err := h.svc.GetDocumentEmbeddingStatus(c.Request.Context(), auth.MustUser(c).ID, kbID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"status": status})
}

func (h *Handler) DocumentDetail(c *gin.Context) {
	var req struct {
		ID string `json:"id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.client.KBDocument.Query().Where(kbdocument.IDEQ(id), kbdocument.UserIDEQ(u.ID)).Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			err = response.NotFound("文件不存在")
		}
		response.Fail(c, err)
		return
	}
	chunks, err := h.svc.client.KBDocumentChunk.Query().Where(
		kbdocumentchunk.DocumentIDEQ(id), kbdocumentchunk.UserIDEQ(u.ID),
	).Order(ent.Asc(kbdocumentchunk.FieldChunkIndex)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	// 分片的辅助召回问题一并返回，文档详情里能直接看到 AI 为每片生成了什么。
	questions, err := h.svc.LoadChunkQuestions(c.Request.Context(), id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	chunkItems := make([]gin.H, 0, len(chunks))
	for _, chunk := range chunks {
		chunkItems = append(chunkItems, gin.H{
			"id": fmt.Sprintf("%d", chunk.ID), "chunkIndex": chunk.ChunkIndex, "page": chunk.Page,
			"locator": chunk.Locator, "contextHeader": chunk.ContextHeader, "startOffset": chunk.StartOffset,
			"endOffset": chunk.EndOffset, "text": chunk.Text, "charCount": chunk.CharCount,
			"tokenEstimate": chunk.TokenEstimate, "chunkType": chunk.ChunkType,
			"parentChunkIndex": chunk.ParentChunkIndex, "questions": questions[chunk.ID],
		})
	}
	blocks := []any{}
	if row.BlocksJSON != nil {
		_ = json.Unmarshal([]byte(*row.BlocksJSON), &blocks)
	}
	tagRows, err := h.svc.client.KBDocumentTag.Query().Where(
		kbdocumenttag.DocumentIDEQ(id),
	).Order(ent.Asc(kbdocumenttag.FieldTag)).All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	tags := make([]string, 0, len(tagRows))
	for _, tag := range tagRows {
		tags = append(tags, tag.Tag)
	}
	document := kbDocumentDTO(row)
	document["charCount"], document["blocks"], document["chunks"], document["summary"] = row.CharCount, blocks, chunkItems, row.Summary
	document["extractedText"] = row.ExtractedText
	document["tags"] = tags
	document["parseConfig"] = decodeDocumentParseConfig(row.ParseConfigJSON)
	document["parseAttempt"] = row.ParseAttempt
	response.OK(c, gin.H{"document": document})
}

func (h *Handler) DocumentMove(c *gin.Context) {
	var req struct {
		ID       string  `json:"id" binding:"required"`
		FolderID *string `json:"folderId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.client.KBDocument.Query().Where(kbdocument.IDEQ(id), kbdocument.UserIDEQ(u.ID)).Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			err = response.NotFound("文件不存在")
		}
		response.Fail(c, err)
		return
	}
	update := row.Update()
	if req.FolderID == nil || strings.TrimSpace(*req.FolderID) == "" {
		update.ClearFolderID()
	} else {
		folderID, err := parsePositiveID(*req.FolderID, "folderId")
		if err != nil {
			response.Fail(c, err)
			return
		}
		exists, err := h.svc.client.KBDocumentFolder.Query().Where(
			kbdocumentfolder.IDEQ(folderID), kbdocumentfolder.UserIDEQ(u.ID), kbdocumentfolder.KnowledgeBaseIDEQ(row.KnowledgeBaseID),
		).Exist(c.Request.Context())
		if err != nil || !exists {
			if err == nil {
				err = response.BadRequest("目标文件夹不存在")
			}
			response.Fail(c, err)
			return
		}
		update.SetFolderID(folderID)
	}
	if _, err := update.Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{"id": req.ID})
}

func (h *Handler) DocumentDelete(c *gin.Context) {
	var req struct {
		ID string `json:"id" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parsePositiveID(req.ID, "id")
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.client.KBDocument.Query().Where(kbdocument.IDEQ(id), kbdocument.UserIDEQ(u.ID)).Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			err = response.NotFound("文件不存在")
		}
		response.Fail(c, err)
		return
	}
	tx, err := h.svc.client.Tx(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if _, err := tx.KBDocumentChunk.Delete().Where(kbdocumentchunk.DocumentIDEQ(id)).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if err := tx.KBDocument.DeleteOneID(id).Exec(c.Request.Context()); err != nil {
		_ = tx.Rollback()
		response.Fail(c, err)
		return
	}
	if err := tx.Commit(); err != nil {
		response.Fail(c, err)
		return
	}
	cleanup := h.svc.cleanupKBDocumentObjectKeys(c.Request.Context(), u.ID, []string{row.ObjectKey})
	// Wiki 重整要逐页 Reduce（每页一次模型调用），放进后台队列，删除接口立即返回。
	wikiCleanup := gin.H{"queued": false}
	if job, queueErr := h.svc.QueueWikiCleanupAfterDocumentDelete(c.Request.Context(), u.ID, row.KnowledgeBaseID); queueErr != nil {
		h.svc.log.Warn("排队 Wiki 重整失败", zap.Int64("knowledge_base_id", row.KnowledgeBaseID), zap.Error(queueErr))
		wikiCleanup["error"] = queueErr.Error()
	} else if job != nil {
		wikiCleanup = gin.H{"queued": true, "jobId": fmt.Sprintf("%d", job.ID)}
	}
	response.OK(c, gin.H{"id": req.ID, "storageCleanup": cleanup, "wikiCleanup": wikiCleanup})
}

// cleanupKBDocumentObjectKeys 只清理当前用户上传前缀下的对象，数据库删除成功后以 best-effort 方式执行。
func (s *Service) cleanupKBDocumentObjectKeys(ctx context.Context, userID int64, objectKeys []string) gin.H {
	deleted := make([]string, 0, len(objectKeys))
	failed := make([]gin.H, 0)
	seen := make(map[string]struct{}, len(objectKeys))
	for _, raw := range objectKeys {
		key := strings.TrimSpace(upload.StripS4KeyPrefix(raw))
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		if key == "" {
			failed = append(failed, gin.H{"objectKey": raw, "errorMessage": "文件对象键为空"})
			continue
		}
		if !strings.HasPrefix(key, fmt.Sprintf("uploads/%d/", userID)) {
			failed = append(failed, gin.H{"objectKey": key, "errorMessage": "文件对象键不属于当前用户，已跳过远程删除"})
			continue
		}
		if err := upload.DeleteObject(ctx, s.cfg, key); err != nil {
			failed = append(failed, gin.H{"objectKey": key, "errorMessage": err.Error()})
			continue
		}
		deleted = append(deleted, key)
	}
	return gin.H{"deletedObjectKeys": deleted, "failedObjectKeys": failed}
}

func kbDocumentDTO(row *ent.KBDocument) gin.H {
	item := gin.H{
		"id": strconv.FormatInt(row.ID, 10), "knowledgeBaseId": strconv.FormatInt(row.KnowledgeBaseID, 10),
		"folderId": nil, "title": row.Title, "fileName": row.FileName, "fileType": row.FileType,
		"contentType": row.ContentType, "objectKey": row.ObjectKey, "sizeBytes": row.SizeBytes,
		"pageCount": row.PageCount, "charCount": row.CharCount, "chunkCount": row.ChunkCount,
		"summary": row.Summary, "status": row.Status, "error": row.Error,
		"createdAt": row.CreatedAt.UTC().Format(time.RFC3339Nano), "updatedAt": row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	if row.FolderID != nil {
		item["folderId"] = strconv.FormatInt(*row.FolderID, 10)
	}
	return item
}
