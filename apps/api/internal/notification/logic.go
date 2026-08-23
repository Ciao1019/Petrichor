// Package notification 移植 src/server/notification（handlers.ts + logic.ts）：
// 通知 summary / list / read / read-all，全部需登录。
package notification

import (
	"regexp"
	"strconv"
	"strings"

	httpx "petrichor/api/internal/httpx"
)

var digitsOnly = regexp.MustCompile(`^\d+$`)

func badReq(msg string) error { return httpx.BadRequest(msg) }

type listInput struct {
	category      string
	readStatus    string
	pageNum       int64
	pageSize      int64
	orderByColumn *string
	isAsc         *string
}

// orderColumnMap 排序列白名单：下划线列名 → 内部名（对应 logic.ts orderColumnMap）。
var orderColumnMap = map[string]string{
	"biz_id":     "bizId",
	"biz_type":   "bizType",
	"category":   "category",
	"created_at": "createdAt",
	"id":         "id",
	"read_at":    "readAt",
	"title":      "title",
	"updated_at": "updatedAt",
}

// dbOrderByColumns 内部名 → 数据库列名（对应 drizzleColumnMap）。
var dbOrderByColumns = map[string]string{
	"bizId":     "biz_id",
	"bizType":   "biz_type",
	"category":  "category",
	"createdAt": "created_at",
	"id":        "id",
	"readAt":    "read_at",
	"title":     "title",
	"updatedAt": "updated_at",
}

type notificationOrder struct {
	column    string
	direction string
}

// normalizePositiveInteger 对应 logic.ts 的 normalizePositiveInteger。
func normalizePositiveInteger(raw any, fallback int64) int64 {
	switch v := raw.(type) {
	case float64:
		if v > 0 && v == float64(int64(v)) {
			return int64(v)
		}
	case string:
		if n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func strAny(v any) string {
	switch value := v.(type) {
	case nil:
		return ""
	case string:
		return value
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(value)
	default:
		return ""
	}
}

func runeLen(s string) int { return len([]rune(s)) }

// validateListInput 复刻 validateNotificationListInput。
func validateListInput(raw map[string]any) (*listInput, error) {
	category := strings.TrimSpace(strAny(raw["category"]))
	readStatus := strings.TrimSpace(strAny(raw["readStatus"]))
	if runeLen(category) > 50 {
		return nil, badReq("消息分类长度不能超过 50")
	}
	if readStatus != "" && readStatus != "ALL" && readStatus != "UNREAD" && readStatus != "READ" {
		return nil, badReq("readStatus 非法")
	}
	input := &listInput{
		category:   category,
		readStatus: readStatus,
		pageNum:    normalizePositiveInteger(raw["pageNum"], 1),
		pageSize:   normalizePositiveInteger(raw["pageSize"], 20),
	}
	if raw["orderByColumn"] != nil {
		s := strAny(raw["orderByColumn"])
		input.orderByColumn = &s
	}
	if raw["isAsc"] != nil {
		s := strAny(raw["isAsc"])
		input.isAsc = &s
	}
	return input, nil
}

// escapeOrderBy 只允许字母数字下划线逗号，其余报错。
func escapeOrderBy(raw string) (string, error) {
	for _, char := range raw {
		code := int(char)
		ok := (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
			(code >= 97 && code <= 122) || char == '_' || char == ','
		if !ok {
			return "", badReq("排序参数有误")
		}
	}
	return raw, nil
}

// toUnderScoreCase 复刻驼峰转下划线（保留已存在的下划线与逗号边界）。
func toUnderScoreCase(value string) string {
	var output strings.Builder
	runes := []rune(value)
	for index, char := range runes {
		if char >= 'A' && char <= 'Z' {
			if index > 0 && runes[index-1] != ',' && runes[index-1] != '_' {
				output.WriteRune('_')
			}
			output.WriteRune(char - 'A' + 'a')
		} else {
			output.WriteRune(char)
		}
	}
	return output.String()
}

// resolveNotificationOrder 复刻 resolveNotificationOrder：
// 未指定时 created_at desc, id desc；指定时按白名单映射并校验方向。
func resolveNotificationOrder(orderByColumn, isAsc *string) ([]notificationOrder, error) {
	columnRaw := ""
	directionRaw := ""
	if orderByColumn != nil {
		columnRaw = strings.TrimSpace(*orderByColumn)
	}
	if isAsc != nil {
		directionRaw = strings.TrimSpace(*isAsc)
	}
	if columnRaw == "" || directionRaw == "" {
		return []notificationOrder{
			{column: "createdAt", direction: "desc"},
			{column: "id", direction: "desc"},
		}, nil
	}

	esc, err := escapeOrderBy(columnRaw)
	if err != nil {
		return nil, err
	}
	columnParts := strings.Split(esc, ",")
	columns := make([]string, 0, len(columnParts))
	for _, column := range columnParts {
		trimmed := toUnderScoreCase(strings.TrimSpace(column))
		if trimmed != "" {
			columns = append(columns, trimmed)
		}
	}

	replacer := strings.NewReplacer("ascending", "asc", "descending", "desc")
	directionParts := strings.Split(replacer.Replace(directionRaw), ",")
	directions := make([]string, 0, len(directionParts))
	for _, direction := range directionParts {
		directions = append(directions, strings.ToLower(strings.TrimSpace(direction)))
	}

	if len(directions) != 1 && len(directions) != len(columns) {
		return nil, badReq("排序参数有误")
	}

	orders := make([]notificationOrder, 0, len(columns))
	for index, column := range columns {
		var direction string
		if len(directions) == 1 {
			direction = directions[0]
		} else if index < len(directions) {
			direction = directions[index]
		}
		if direction != "asc" && direction != "desc" {
			return nil, badReq("排序参数有误")
		}
		mapped, ok := orderColumnMap[column]
		if !ok {
			return nil, badReq("排序参数有误")
		}
		orders = append(orders, notificationOrder{column: mapped, direction: direction})
	}
	return orders, nil
}

// toSQLOrderBy 内部名 → SQL 片段（对应 toNotificationOrderBy）。
func toSQLOrderBy(orders []notificationOrder) string {
	clauses := make([]string, 0, len(orders))
	for _, order := range orders {
		column := dbOrderByColumns[order.column]
		if column == "" {
			continue
		}
		if order.direction == "asc" {
			clauses = append(clauses, column+" ASC")
		} else {
			clauses = append(clauses, column+" DESC")
		}
	}
	return strings.Join(clauses, ", ")
}
