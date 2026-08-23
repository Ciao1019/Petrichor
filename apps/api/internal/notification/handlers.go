// handlers.go 复刻 notification/handlers.ts：summary / list / read / read-all。
package notification

import (
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/db"
	httpx "petrichor/api/internal/httpx"
)

const notificationColumns = `id, user_id, category, biz_type, biz_id, title, content,
	payload_json, read_at, created_at, updated_at`

type notificationRecord struct {
	id          int64
	userID      int64
	category    string
	bizType     string
	bizID       int64
	title       string
	content     string
	payloadJSON *string
	readAt      *time.Time
	createdAt   time.Time
	updatedAt   time.Time
}

func scanNotification(scanner interface{ Scan(dest ...any) error }) (*notificationRecord, error) {
	var r notificationRecord
	err := scanner.Scan(&r.id, &r.userID, &r.category, &r.bizType, &r.bizID, &r.title,
		&r.content, &r.payloadJSON, &r.readAt, &r.createdAt, &r.updatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// buildNotificationItem 对应 buildNotificationItem：bigint ID 字符串化 + ISO 时间。
func buildNotificationItem(r *notificationRecord) map[string]any {
	return map[string]any{
		"id":        strconvFormatInt(r.id),
		"category":  r.category,
		"bizType":   r.bizType,
		"bizId":     strconvFormatInt(r.bizID),
		"title":     r.title,
		"content":   r.content,
		"payload":   parsePayloadJSON(r.payloadJSON),
		"read":      r.readAt != nil,
		"readAt":    isoPtr(r.readAt),
		"createdAt": httpx.FormatISO(r.createdAt),
	}
}

// parsePayloadJSON 对应 parseNotificationPayload：非对象形态一律回退空对象。
func parsePayloadJSON(raw *string) map[string]any {
	result := map[string]any{}
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return result
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return result
	}
	if obj, ok := parsed.(map[string]any); ok {
		return obj
	}
	return result
}

func strconvFormatInt(n int64) string {
	return strconv.FormatInt(n, 10)
}

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return httpx.FormatISO(*t)
}

func readBody(c *gin.Context) (map[string]any, error) {
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		return nil, badReq("请求体必须是合法 JSON")
	}
	return raw, nil
}

// Summary POST /api/notification/summary。
func Summary(c *gin.Context) {
	user := auth.CurrentUser(c)
	ctx := c.Request.Context()
	pool := db.Pool()

	var unreadCount int64
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM petrichor_notification WHERE user_id = $1 AND read_at IS NULL`,
		user.ID).Scan(&unreadCount); err != nil {
		httpx.HandleError(c, err)
		return
	}

	var latestID *int64
	row := pool.QueryRow(ctx,
		`SELECT id FROM petrichor_notification WHERE user_id = $1 AND read_at IS NULL
		 ORDER BY created_at DESC, id DESC LIMIT 1`, user.ID)
	if err := row.Scan(&latestID); err != nil && !isNoRows(err) {
		httpx.HandleError(c, err)
		return
	}

	var latestAny any
	if latestID != nil {
		latestAny = strconvFormatInt(*latestID)
	}
	httpx.OK(c, map[string]any{
		"unreadCount":    unreadCount,
		"latestUnreadId": latestAny,
	})
}

func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// List POST /api/notification/list。
func List(c *gin.Context) {
	raw, err := readBody(c)
	if err != nil {
		httpx.HandleError(c, asBadRequest(err))
		return
	}
	input, verr := validateListInput(raw)
	if verr != nil {
		httpx.HandleError(c, verr)
		return
	}
	user := auth.CurrentUser(c)
	ctx := c.Request.Context()
	pool := db.Pool()

	where := "user_id = $1"
	args := []any{user.ID}
	argIndex := 2
	if input.category != "" {
		where += " AND category = $" + itoaArg(argIndex)
		args = append(args, input.category)
		argIndex++
	}
	switch input.readStatus {
	case "UNREAD":
		where += " AND read_at IS NULL"
	case "READ":
		where += " AND read_at IS NOT NULL"
	}

	var total int64
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM petrichor_notification WHERE `+where, args...).Scan(&total); err != nil {
		httpx.HandleError(c, err)
		return
	}

	orders, oerr := resolveNotificationOrder(input.orderByColumn, input.isAsc)
	if oerr != nil {
		httpx.HandleError(c, oerr)
		return
	}

	offset := (input.pageNum - 1) * input.pageSize
	rows, qerr := pool.Query(ctx,
		`SELECT `+notificationColumns+` FROM petrichor_notification
		 WHERE `+where+" ORDER BY "+toSQLOrderBy(orders)+
			" LIMIT $"+itoaArg(argIndex)+" OFFSET $"+itoaArg(argIndex+1),
		append(args, input.pageSize, offset)...)
	if qerr != nil {
		httpx.HandleError(c, qerr)
		return
	}
	defer rows.Close()

	items := []map[string]any{}
	for rows.Next() {
		record, serr := scanNotification(rows)
		if serr != nil {
			httpx.HandleError(c, serr)
			return
		}
		items = append(items, buildNotificationItem(record))
	}
	if err := rows.Err(); err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.TableData(c, items, total)
}

func itoaArg(n int) string { return strconv.Itoa(n) }

// Read POST /api/notification/read：单条已读（幂等，只更新未读行）。
func Read(c *gin.Context) {
	raw, err := readBody(c)
	if err != nil {
		httpx.HandleError(c, asBadRequest(err))
		return
	}
	rawID := strings.TrimSpace(strAny(raw["notificationId"]))
	if rawID == "" || !digitsOnly.MatchString(rawID) {
		httpx.HandleError(c, badReq("消息ID非法"))
		return
	}
	notificationID, perr := strconv.ParseInt(rawID, 10, 64)
	if perr != nil {
		httpx.HandleError(c, badReq("消息ID非法"))
		return
	}
	user := auth.CurrentUser(c)
	readAt := time.Now()
	if _, uerr := db.Pool().Exec(c.Request.Context(),
		`UPDATE petrichor_notification SET read_at = $1, updated_at = $1
		 WHERE id = $2 AND user_id = $3 AND read_at IS NULL`,
		readAt, notificationID, user.ID); uerr != nil {
		httpx.HandleError(c, uerr)
		return
	}
	httpx.OK(c, map[string]any{
		"notificationId": strconvFormatInt(notificationID),
		"readAt":         httpx.FormatISO(readAt),
	})
}

// ReadAll POST /api/notification/read-all：按分类（可选）批量已读，返回更新条数。
func ReadAll(c *gin.Context) {
	raw, err := readBody(c)
	if err != nil {
		httpx.HandleError(c, asBadRequest(err))
		return
	}
	category := strings.TrimSpace(strAny(raw["category"]))
	if runeLen(category) > 50 {
		httpx.HandleError(c, badReq("消息分类长度不能超过 50"))
		return
	}
	user := auth.CurrentUser(c)
	ctx := c.Request.Context()

	where := "user_id = $1 AND read_at IS NULL"
	args := []any{user.ID}
	if category != "" {
		where += " AND category = $2"
		args = append(args, category)
	}

	var updatedCount int32
	err = db.Pool().QueryRow(ctx,
		`WITH moved AS (
			UPDATE petrichor_notification SET read_at = $`+itoaArg(len(args)+1)+`,
			 updated_at = $`+itoaArg(len(args)+1)+` WHERE `+where+` RETURNING id
		) SELECT count(*) FROM moved`,
		append(args, time.Now())...).Scan(&updatedCount)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	httpx.OK(c, map[string]any{
		"updatedCount": updatedCount,
		"readAt":       httpx.FormatISO(time.Now()),
	})
}

func asBadRequest(err error) error {
	return badReq("请求体必须是合法 JSON")
}
