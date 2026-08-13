package notification

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/notification"
	"github.com/Ciao1019/Petrichor/apps/api/internal/auth"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

type Handler struct {
	client *ent.Client
}

func NewHandler(client *ent.Client) *Handler {
	return &Handler{client: client}
}

type ItemDTO struct {
	ID        string         `json:"id"`
	Category  string         `json:"category"`
	BizType   string         `json:"bizType"`
	BizID     string         `json:"bizId"`
	Title     string         `json:"title"`
	Content   string         `json:"content"`
	Payload   map[string]any `json:"payload"`
	Read      bool           `json:"read"`
	ReadAt    *string        `json:"readAt"`
	CreatedAt string         `json:"createdAt"`
}

func toDTO(row *ent.Notification) (ItemDTO, error) {
	payload := map[string]any{}
	if row.PayloadJSON != nil && strings.TrimSpace(*row.PayloadJSON) != "" {
		var decoded any
		if err := json.Unmarshal([]byte(*row.PayloadJSON), &decoded); err != nil {
			return ItemDTO{}, fmt.Errorf("解析通知 payload 失败: %w", err)
		}
		if object, ok := decoded.(map[string]any); ok {
			payload = object
		}
	}

	var readAt *string
	if row.ReadAt != nil {
		value := row.ReadAt.UTC().Format(time.RFC3339Nano)
		readAt = &value
	}
	return ItemDTO{
		ID:        strconv.FormatInt(row.ID, 10),
		Category:  row.Category,
		BizType:   row.BizType,
		BizID:     strconv.FormatInt(row.BizID, 10),
		Title:     row.Title,
		Content:   row.Content,
		Payload:   payload,
		Read:      row.ReadAt != nil,
		ReadAt:    readAt,
		CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func (h *Handler) Summary(c *gin.Context) {
	u := auth.MustUser(c)
	query := h.client.Notification.Query().
		Where(notification.UserIDEQ(u.ID), notification.ReadAtIsNil())
	unread, err := query.Clone().Count(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	latest, err := query.
		Order(ent.Desc(notification.FieldCreatedAt), ent.Desc(notification.FieldID)).
		First(c.Request.Context())
	if err != nil && !ent.IsNotFound(err) {
		response.Fail(c, err)
		return
	}
	var latestUnreadID *string
	if latest != nil {
		value := strconv.FormatInt(latest.ID, 10)
		latestUnreadID = &value
	}
	response.OK(c, gin.H{
		"unreadCount":    unread,
		"latestUnreadId": latestUnreadID,
	})
}

type listRequest struct {
	Category      string `json:"category"`
	ReadStatus    string `json:"readStatus"`
	PageNum       int    `json:"pageNum"`
	PageSize      int    `json:"pageSize"`
	OrderByColumn string `json:"orderByColumn"`
	IsAsc         string `json:"isAsc"`
}

func (h *Handler) List(c *gin.Context) {
	u := auth.MustUser(c)
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	req, err := validateListInput(raw)
	if err != nil {
		response.Fail(c, err)
		return
	}

	query := h.client.Notification.Query().Where(notification.UserIDEQ(u.ID))
	if req.Category != "" {
		query = query.Where(notification.CategoryEQ(req.Category))
	}
	switch req.ReadStatus {
	case "UNREAD":
		query = query.Where(notification.ReadAtIsNil())
	case "READ":
		query = query.Where(notification.ReadAtNotNil())
	}
	total, err := query.Clone().Count(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	orders, err := resolveOrder(req.OrderByColumn, req.IsAsc)
	if err != nil {
		response.Fail(c, err)
		return
	}
	rows, err := query.
		Order(orders...).
		Offset((req.PageNum - 1) * req.PageSize).
		Limit(req.PageSize).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	out := make([]ItemDTO, 0, len(rows))
	for _, row := range rows {
		item, err := toDTO(row)
		if err != nil {
			response.Fail(c, err)
			return
		}
		out = append(out, item)
	}
	response.TableData(c, out, total)
}

func resolveOrder(rawColumns, rawDirections string) ([]notification.OrderOption, error) {
	rawColumns = strings.TrimSpace(rawColumns)
	rawDirections = strings.TrimSpace(rawDirections)
	if rawColumns == "" || rawDirections == "" {
		return []notification.OrderOption{
			ent.Desc(notification.FieldCreatedAt),
			ent.Desc(notification.FieldID),
		}, nil
	}
	for _, char := range rawColumns {
		if !((char >= '0' && char <= '9') || (char >= 'A' && char <= 'Z') ||
			(char >= 'a' && char <= 'z') || char == '_' || char == ',') {
			return nil, response.BadRequest("排序参数有误")
		}
	}
	fieldMap := map[string]string{
		"bizId": notification.FieldBizID, "biz_id": notification.FieldBizID,
		"bizType": notification.FieldBizType, "biz_type": notification.FieldBizType,
		"category":  notification.FieldCategory,
		"createdAt": notification.FieldCreatedAt, "created_at": notification.FieldCreatedAt,
		"id":     notification.FieldID,
		"readAt": notification.FieldReadAt, "read_at": notification.FieldReadAt,
		"title":     notification.FieldTitle,
		"updatedAt": notification.FieldUpdatedAt, "updated_at": notification.FieldUpdatedAt,
	}
	columnParts := strings.Split(rawColumns, ",")
	columns := make([]string, 0, len(columnParts))
	for _, column := range columnParts {
		if column = strings.TrimSpace(column); column != "" {
			field, ok := fieldMap[column]
			if !ok {
				return nil, response.BadRequest("排序参数有误")
			}
			columns = append(columns, field)
		}
	}
	if len(columns) == 0 {
		return nil, response.BadRequest("排序参数有误")
	}
	directionParts := strings.Split(strings.NewReplacer("ascending", "asc", "descending", "desc").Replace(rawDirections), ",")
	if len(directionParts) != 1 && len(directionParts) != len(columns) {
		return nil, response.BadRequest("排序参数有误")
	}
	orders := make([]notification.OrderOption, 0, len(columns))
	for index, field := range columns {
		direction := strings.ToLower(strings.TrimSpace(directionParts[0]))
		if len(directionParts) > 1 {
			direction = strings.ToLower(strings.TrimSpace(directionParts[index]))
		}
		switch direction {
		case "asc":
			orders = append(orders, ent.Asc(field))
		case "desc":
			orders = append(orders, ent.Desc(field))
		default:
			return nil, response.BadRequest("排序参数有误")
		}
	}
	return orders, nil
}

type readRequest struct {
	NotificationID string `json:"notificationId" binding:"required"`
}

func (h *Handler) Read(c *gin.Context) {
	u := auth.MustUser(c)
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	id, err := validateNotificationID(raw["notificationId"])
	if err != nil {
		response.Fail(c, err)
		return
	}
	now := time.Now().UTC()
	if _, err := h.client.Notification.Update().
		Where(notification.IDEQ(id), notification.UserIDEQ(u.ID), notification.ReadAtIsNil()).
		SetReadAt(now).
		Save(c.Request.Context()); err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"notificationId": strconv.FormatInt(id, 10),
		"readAt":         now.Format(time.RFC3339Nano),
	})
}

type readAllRequest struct {
	Category string `json:"category"`
}

func (h *Handler) ReadAll(c *gin.Context) {
	u := auth.MustUser(c)
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	category, err := validateCategory(raw["category"])
	if err != nil {
		response.Fail(c, err)
		return
	}
	update := h.client.Notification.Update().
		Where(notification.UserIDEQ(u.ID), notification.ReadAtIsNil())
	if category != "" {
		update = update.Where(notification.CategoryEQ(category))
	}
	now := time.Now().UTC()
	n, err := update.SetReadAt(now).Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	response.OK(c, gin.H{
		"updatedCount": n,
		"readAt":       now.Format(time.RFC3339Nano),
	})
}
