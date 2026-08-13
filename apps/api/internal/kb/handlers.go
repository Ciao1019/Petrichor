package kb

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbdocument"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
	"github.com/Ciao1019/Petrichor/apps/api/ent/knowledgebase"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type Service struct {
	client *ent.Client
	sql    *sql.DB
	log    *zap.Logger
	cfg    *config.Config

	wikiSubmitMu   sync.Mutex
	wikiWorkerOnce sync.Once
	wikiWake       chan struct{}
}

func NewService(client *ent.Client, sqlDB *sql.DB, log *zap.Logger, cfg *config.Config) *Service {
	return &Service{
		client:   client,
		sql:      sqlDB,
		log:      log,
		cfg:      cfg,
		wikiWake: make(chan struct{}, 1),
	}
}

// StartWikiWorker 启动持久 Wiki 任务消费者。只有应用主服务调用，临时的 Agent Service 不重复启动。
func (s *Service) StartWikiWorker(ctx context.Context) {
	s.wikiWorkerOnce.Do(func() {
		go s.runWikiWorker(ctx)
	})
}

type Handler struct {
	svc *Service
}

func NewHandler(svc *Service) *Handler {
	return &Handler{svc: svc}
}

type KnowledgeBaseDTO struct {
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	ChunkStrategy     string   `json:"chunkStrategy"`
	ChunkSize         int      `json:"chunkSize"`
	ChunkOverlap      int      `json:"chunkOverlap"`
	ChunkSeparators   []string `json:"chunkSeparators"`
	EnableParentChild bool     `json:"enableParentChild"`
	ParentChunkSize   int      `json:"parentChunkSize"`
	ChildChunkSize    int      `json:"childChunkSize"`
	ChatModelID       *string  `json:"chatModelId"`
	EmbeddingModelID  *string  `json:"embeddingModelId"`
	RerankModelID     *string  `json:"rerankModelId"`
	WikiEnabled       bool     `json:"wikiEnabled"`
	DocumentCount     int      `json:"documentCount"`
	WikiPageCount     int      `json:"wikiPageCount"`
	CreatedAt         string   `json:"createdAt"`
	UpdatedAt         string   `json:"updatedAt"`
}

type listRequest struct {
	PageNum       int    `json:"pageNum"`
	PageSize      int    `json:"pageSize"`
	IsAsc         *bool  `json:"isAsc"`
	OrderByColumn string `json:"orderByColumn"`
}

type createRequest struct {
	Name              string   `json:"name" binding:"required,min=1"`
	Description       *string  `json:"description"`
	ChunkStrategy     string   `json:"chunkStrategy"`
	ChunkSize         int      `json:"chunkSize"`
	ChunkOverlap      int      `json:"chunkOverlap"`
	ChunkSeparators   []string `json:"chunkSeparators"`
	EnableParentChild bool     `json:"enableParentChild"`
	ParentChunkSize   int      `json:"parentChunkSize"`
	ChildChunkSize    int      `json:"childChunkSize"`
	ChatModelID       *string  `json:"chatModelId"`
	EmbeddingModelID  *string  `json:"embeddingModelId"`
	RerankModelID     *string  `json:"rerankModelId"`
	WikiEnabled       bool     `json:"wikiEnabled"`
}

type idRequest struct {
	KnowledgeBaseID string `json:"knowledgeBaseId" binding:"required"`
}

type updateRequest struct {
	KnowledgeBaseID   string   `json:"knowledgeBaseId" binding:"required"`
	Name              string   `json:"name" binding:"required,min=1"`
	Description       *string  `json:"description"`
	ChunkStrategy     string   `json:"chunkStrategy"`
	ChunkSize         int      `json:"chunkSize"`
	ChunkOverlap      int      `json:"chunkOverlap"`
	ChunkSeparators   []string `json:"chunkSeparators"`
	EnableParentChild bool     `json:"enableParentChild"`
	ParentChunkSize   int      `json:"parentChunkSize"`
	ChildChunkSize    int      `json:"childChunkSize"`
	ChatModelID       *string  `json:"chatModelId"`
	EmbeddingModelID  *string  `json:"embeddingModelId"`
	RerankModelID     *string  `json:"rerankModelId"`
	WikiEnabled       bool     `json:"wikiEnabled"`
}

func toDTO(row *ent.KnowledgeBase) KnowledgeBaseDTO {
	desc := ""
	if row.Description != nil {
		desc = *row.Description
	}
	separators := []string{"\n\n", "\n", "。", "！", "？", ";", "；"}
	if row.ChunkSeparatorsJSON != nil {
		var parsed []string
		if json.Unmarshal([]byte(*row.ChunkSeparatorsJSON), &parsed) == nil && len(parsed) > 0 {
			separators = parsed
		}
	}
	return KnowledgeBaseDTO{
		ID:                fmt.Sprintf("%d", row.ID),
		Name:              row.Name,
		Description:       desc,
		ChunkStrategy:     row.ChunkStrategy,
		ChunkSize:         row.ChunkSize,
		ChunkOverlap:      row.ChunkOverlap,
		ChunkSeparators:   separators,
		EnableParentChild: row.EnableParentChild,
		ParentChunkSize:   row.ParentChunkSize,
		ChildChunkSize:    row.ChildChunkSize,
		ChatModelID:       formatOptionalID(row.ChatModelID),
		EmbeddingModelID:  formatOptionalID(row.EmbeddingModelID),
		RerankModelID:     formatOptionalID(row.RerankModelID),
		WikiEnabled:       row.WikiEnabled,
		CreatedAt:         row.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt:         row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

func formatOptionalID(value *int64) *string {
	if value == nil {
		return nil
	}
	formatted := strconv.FormatInt(*value, 10)
	return &formatted
}

func parseID(raw string) (int64, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, response.BadRequest("knowledgeBaseId 无效")
	}
	return id, nil
}

func (h *Handler) List(c *gin.Context) {
	var req listRequest
	_ = c.ShouldBindJSON(&req)
	if req.PageNum <= 0 {
		req.PageNum = 1
	}
	if req.PageSize <= 0 {
		req.PageSize = 20
	}
	if req.PageSize > 100 {
		req.PageSize = 100
	}
	asc := false
	if req.IsAsc != nil {
		asc = *req.IsAsc
	}

	u := auth.MustUser(c)
	rows, total, err := h.svc.List(c.Request.Context(), u.ID, req.PageNum, req.PageSize, asc)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.TableData(c, rows, total)
}

func (h *Handler) Create(c *gin.Context) {
	var req createRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.Create(c.Request.Context(), u.ID, strings.TrimSpace(req.Name), req)
	if err != nil {
		response.Fail(c, err)
		return
	}
	dto, err := h.svc.enrichKnowledgeBaseDTO(c.Request.Context(), u.ID, toDTO(row))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, dto)
}

func (h *Handler) Detail(c *gin.Context) {
	var req idRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.GetOwned(c.Request.Context(), u.ID, id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	dto, err := h.svc.enrichKnowledgeBaseDTO(c.Request.Context(), u.ID, toDTO(row))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, dto)
}

func (h *Handler) Update(c *gin.Context) {
	var req updateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	row, err := h.svc.Update(c.Request.Context(), u.ID, id, strings.TrimSpace(req.Name), req)
	if err != nil {
		response.Fail(c, err)
		return
	}
	dto, err := h.svc.enrichKnowledgeBaseDTO(c.Request.Context(), u.ID, toDTO(row))
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, dto)
}

func (h *Handler) Delete(c *gin.Context) {
	var req idRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := parseID(req.KnowledgeBaseID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	u := auth.MustUser(c)
	objectKeys, err := h.svc.Delete(c.Request.Context(), u.ID, id)
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"knowledgeBaseId": fmt.Sprintf("%d", id),
		"storageCleanup":  h.svc.cleanupKBDocumentObjectKeys(c.Request.Context(), u.ID, objectKeys),
	})
}

func (s *Service) List(ctx context.Context, userID int64, pageNum, pageSize int, asc bool) ([]KnowledgeBaseDTO, int, error) {
	total, err := s.client.KnowledgeBase.Query().
		Where(knowledgebase.UserIDEQ(userID)).
		Count(ctx)
	if err != nil {
		return nil, 0, err
	}

	q := s.client.KnowledgeBase.Query().Where(knowledgebase.UserIDEQ(userID))
	if asc {
		q = q.Order(ent.Asc(knowledgebase.FieldUpdatedAt), ent.Asc(knowledgebase.FieldID))
	} else {
		q = q.Order(ent.Desc(knowledgebase.FieldUpdatedAt), ent.Desc(knowledgebase.FieldID))
	}

	rows, err := q.Offset((pageNum - 1) * pageSize).Limit(pageSize).All(ctx)
	if err != nil {
		return nil, 0, err
	}

	out := make([]KnowledgeBaseDTO, 0, len(rows))
	for _, row := range rows {
		dto, err := s.enrichKnowledgeBaseDTO(ctx, userID, toDTO(row))
		if err != nil {
			return nil, 0, err
		}
		out = append(out, dto)
	}
	return out, total, nil
}

func (s *Service) Create(ctx context.Context, userID int64, name string, req createRequest) (*ent.KnowledgeBase, error) {
	if name == "" {
		return nil, response.BadRequest("名称不能为空")
	}
	settings, err := s.validateKnowledgeBaseSettings(ctx, userID, req.ChunkStrategy, req.ChunkSize, req.ChunkOverlap, req.ChunkSeparators, req.ChatModelID, req.EmbeddingModelID, req.RerankModelID)
	if err != nil {
		return nil, err
	}
	builder := s.client.KnowledgeBase.Create().
		SetUserID(userID).
		SetName(name).
		SetChunkStrategy(settings.strategy).
		SetChunkSize(settings.size).
		SetChunkOverlap(settings.overlap).
		SetChunkSeparatorsJSON(settings.separatorsJSON).
		SetEnableParentChild(req.EnableParentChild).
		SetParentChunkSize(clampChunkDimension(req.ParentChunkSize)).
		SetChildChunkSize(clampChunkDimension(req.ChildChunkSize)).
		SetWikiEnabled(req.WikiEnabled).
		SetNillableChatModelID(settings.chatModelID).
		SetNillableEmbeddingModelID(settings.embeddingModelID).
		SetNillableRerankModelID(settings.rerankModelID)
	if req.Description != nil {
		v := strings.TrimSpace(*req.Description)
		if v != "" {
			builder.SetDescription(v)
		}
	}
	return builder.Save(ctx)
}

func (s *Service) GetOwned(ctx context.Context, userID, kbID int64) (*ent.KnowledgeBase, error) {
	row, err := s.client.KnowledgeBase.Query().
		Where(knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID)).
		Only(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, response.NotFound("知识库不存在")
		}
		return nil, err
	}
	return row, nil
}

func (s *Service) Update(ctx context.Context, userID, kbID int64, name string, req updateRequest) (*ent.KnowledgeBase, error) {
	if name == "" {
		return nil, response.BadRequest("名称不能为空")
	}
	settings, err := s.validateKnowledgeBaseSettings(ctx, userID, req.ChunkStrategy, req.ChunkSize, req.ChunkOverlap, req.ChunkSeparators, req.ChatModelID, req.EmbeddingModelID, req.RerankModelID)
	if err != nil {
		return nil, err
	}
	upd := s.client.KnowledgeBase.Update().
		Where(knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID)).
		SetName(name).
		SetChunkStrategy(settings.strategy).
		SetChunkSize(settings.size).
		SetChunkOverlap(settings.overlap).
		SetChunkSeparatorsJSON(settings.separatorsJSON).
		SetEnableParentChild(req.EnableParentChild).
		SetParentChunkSize(clampChunkDimension(req.ParentChunkSize)).
		SetChildChunkSize(clampChunkDimension(req.ChildChunkSize)).
		SetWikiEnabled(req.WikiEnabled)
	if settings.chatModelID == nil {
		upd.ClearChatModelID()
	} else {
		upd.SetChatModelID(*settings.chatModelID)
	}
	if settings.embeddingModelID == nil {
		upd.ClearEmbeddingModelID()
	} else {
		upd.SetEmbeddingModelID(*settings.embeddingModelID)
	}
	if settings.rerankModelID == nil {
		upd.ClearRerankModelID()
	} else {
		upd.SetRerankModelID(*settings.rerankModelID)
	}
	if req.Description == nil || strings.TrimSpace(*req.Description) == "" {
		upd.ClearDescription()
	} else {
		upd.SetDescription(strings.TrimSpace(*req.Description))
	}
	n, err := upd.Save(ctx)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, response.NotFound("知识库不存在")
	}
	return s.GetOwned(ctx, userID, kbID)
}

type validatedKnowledgeBaseSettings struct {
	strategy         string
	size             int
	overlap          int
	separatorsJSON   string
	chatModelID      *int64
	embeddingModelID *int64
	rerankModelID    *int64
}

func (s *Service) validateKnowledgeBaseSettings(
	ctx context.Context,
	userID int64,
	strategy string,
	size int,
	overlap int,
	separators []string,
	chatRaw, embeddingRaw, rerankRaw *string,
) (validatedKnowledgeBaseSettings, error) {
	strategy = strings.ToLower(strings.TrimSpace(strategy))
	if strategy == "" {
		strategy = "auto"
	}
	if strategy != "auto" && strategy != "heading" && strategy != "heuristic" && strategy != "recursive" && strategy != "paragraph" && strategy != "fixed" {
		return validatedKnowledgeBaseSettings{}, response.BadRequest("不支持的切片规则")
	}
	if size == 0 {
		size = 512
	}
	if size < 200 || size > 12000 {
		return validatedKnowledgeBaseSettings{}, response.BadRequest("切片长度需在 200 到 12000 之间")
	}
	if overlap < 0 || overlap >= size {
		return validatedKnowledgeBaseSettings{}, response.BadRequest("切片重叠必须大于等于 0 且小于切片长度")
	}
	cleanSeparators := make([]string, 0, len(separators))
	seen := map[string]struct{}{}
	for _, separator := range separators {
		if separator == "" || len([]rune(separator)) > 16 {
			continue
		}
		if _, ok := seen[separator]; ok {
			continue
		}
		seen[separator] = struct{}{}
		cleanSeparators = append(cleanSeparators, separator)
	}
	if len(cleanSeparators) == 0 {
		cleanSeparators = []string{"\n\n", "\n", "。"}
	}
	raw, _ := json.Marshal(cleanSeparators)
	chatID, err := s.validateKnowledgeBaseModel(ctx, userID, chatRaw, "CHAT")
	if err != nil {
		return validatedKnowledgeBaseSettings{}, err
	}
	embeddingID, err := s.validateKnowledgeBaseModel(ctx, userID, embeddingRaw, "EMBEDDING")
	if err != nil {
		return validatedKnowledgeBaseSettings{}, err
	}
	rerankID, err := s.validateKnowledgeBaseModel(ctx, userID, rerankRaw, "RERANK")
	if err != nil {
		return validatedKnowledgeBaseSettings{}, err
	}
	return validatedKnowledgeBaseSettings{
		strategy: strategy, size: size, overlap: overlap, separatorsJSON: string(raw),
		chatModelID: chatID, embeddingModelID: embeddingID, rerankModelID: rerankID,
	}, nil
}

func (s *Service) validateKnowledgeBaseModel(ctx context.Context, userID int64, raw *string, configType string) (*int64, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	id, err := parsePositiveID(*raw, strings.ToLower(configType)+"ModelId")
	if err != nil {
		return nil, err
	}
	exists, err := s.client.AIModelConfig.Query().Where(
		aimodelconfig.IDEQ(id), aimodelconfig.UserIDEQ(userID), aimodelconfig.ConfigTypeEQ(configType), aimodelconfig.EnabledEQ(true),
	).Exist(ctx)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, response.BadRequest(configType + " 模型不存在、类型不符或未启用")
	}
	return &id, nil
}

func (s *Service) enrichKnowledgeBaseDTO(ctx context.Context, userID int64, dto KnowledgeBaseDTO) (KnowledgeBaseDTO, error) {
	kbID, _ := strconv.ParseInt(dto.ID, 10, 64)
	documentCount, err := s.client.KBDocument.Query().Where(kbdocument.UserIDEQ(userID), kbdocument.KnowledgeBaseIDEQ(kbID)).Count(ctx)
	if err != nil {
		return dto, err
	}
	wikiPageCount, err := s.client.KBWikiPage.Query().Where(kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil()).Count(ctx)
	if err != nil {
		return dto, err
	}
	dto.DocumentCount, dto.WikiPageCount = documentCount, wikiPageCount
	return dto, nil
}

func (s *Service) Delete(ctx context.Context, userID, kbID int64) ([]string, error) {
	documents, err := s.client.KBDocument.Query().Where(
		kbdocument.UserIDEQ(userID), kbdocument.KnowledgeBaseIDEQ(kbID),
	).Select(kbdocument.FieldObjectKey).All(ctx)
	if err != nil {
		return nil, err
	}
	objectKeys := make([]string, 0, len(documents))
	for _, document := range documents {
		objectKeys = append(objectKeys, document.ObjectKey)
	}
	n, err := s.client.KnowledgeBase.Delete().
		Where(knowledgebase.IDEQ(kbID), knowledgebase.UserIDEQ(userID)).
		Exec(ctx)
	if err != nil {
		return nil, err
	}
	if n == 0 {
		return nil, response.NotFound("知识库不存在")
	}
	return objectKeys, nil
}
