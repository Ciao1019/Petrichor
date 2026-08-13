package notification

import (
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

func validateListInput(raw map[string]any) (listRequest, error) {
	category, err := validateCategory(raw["category"])
	if err != nil {
		return listRequest{}, err
	}
	status := strings.TrimSpace(notificationString(raw["readStatus"]))
	if status != "" && status != "ALL" && status != "UNREAD" && status != "READ" {
		return listRequest{}, response.BadRequest("readStatus 非法")
	}
	return listRequest{
		Category: category, ReadStatus: status,
		PageNum: positiveInteger(raw["pageNum"], 1), PageSize: positiveInteger(raw["pageSize"], 20),
		OrderByColumn: notificationString(raw["orderByColumn"]), IsAsc: notificationString(raw["isAsc"]),
	}, nil
}

func validateCategory(raw any) (string, error) {
	category := strings.TrimSpace(notificationString(raw))
	if utf8.RuneCountInString(category) > 50 {
		return "", response.BadRequest("消息分类长度不能超过 50")
	}
	return category, nil
}

func validateNotificationID(raw any) (int64, error) {
	value := strings.TrimSpace(notificationString(raw))
	if value == "" {
		return 0, response.BadRequest("消息ID非法")
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, response.BadRequest("消息ID非法")
		}
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return 0, response.BadRequest("消息ID非法")
	}
	return id, nil
}

func positiveInteger(raw any, fallback int) int {
	value, err := strconv.ParseFloat(strings.TrimSpace(notificationString(raw)), 64)
	if err != nil || value <= 0 || value != float64(int(value)) {
		return fallback
	}
	return int(value)
}

func notificationString(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
