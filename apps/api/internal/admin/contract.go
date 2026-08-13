package admin

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Ciao1019/Petrichor/apps/api/ent/user"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

var adminEmailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)

type adminCreateInput struct {
	Email, Password, Name, SystemRole string
}

type adminOrder struct {
	Field     string
	Ascending bool
}

var adminOrderFields = map[string]string{
	"avatar": user.FieldAvatar, "created_at": user.FieldCreatedAt, "email": user.FieldEmail,
	"id": user.FieldID, "nickname": user.FieldNickname, "signature": user.FieldSignature,
	"system_role": user.FieldSystemRole, "updated_at": user.FieldUpdatedAt,
	"username": user.FieldUsername, "user_type": user.FieldUserType,
}

func validateAdminCreateInput(raw map[string]any) (adminCreateInput, error) {
	email := strings.TrimSpace(valueString(raw["email"]))
	password := valueString(raw["password"])
	name := strings.TrimSpace(valueString(raw["name"]))
	role := strings.TrimSpace(valueString(raw["systemRole"]))
	if email == "" {
		return adminCreateInput{}, response.BadRequest("不能为空")
	}
	if !adminEmailPattern.MatchString(email) {
		return adminCreateInput{}, response.BadRequest("不是一个合法的电子邮件地址")
	}
	if strings.TrimSpace(password) == "" {
		return adminCreateInput{}, response.BadRequest("不能为空")
	}
	length := utf8.RuneCountInString(password)
	if length < 6 || length > 50 {
		return adminCreateInput{}, response.BadRequest("个数必须在6和50之间")
	}
	if name == "" {
		return adminCreateInput{}, response.BadRequest("不能为空")
	}
	if utf8.RuneCountInString(name) > 80 {
		return adminCreateInput{}, response.BadRequest("个数必须在0和80之间")
	}
	if role == "" {
		role = "USER"
	}
	if role != "USER" && role != "SUPER_ADMIN" {
		return adminCreateInput{}, response.BadRequest("systemRole 非法")
	}
	return adminCreateInput{Email: email, Password: password, Name: name, SystemRole: role}, nil
}

func validateAdminDeleteInput(raw any) (int64, error) {
	value := strings.TrimSpace(valueString(raw))
	if value == "" {
		return 0, response.BadRequest("用户ID非法")
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return 0, response.BadRequest("用户ID非法")
		}
	}
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return 0, response.BadRequest("用户ID非法")
	}
	return id, nil
}

func validateAdminKeyword(raw any) (string, error) {
	value := valueString(raw)
	if utf8.RuneCountInString(value) > 200 {
		return "", response.BadRequest("关键字长度不能超过 200")
	}
	return value, nil
}

func normalizeAdminPagination(raw map[string]any) (int, int) {
	parse := func(value any, fallback int) int {
		number, err := strconv.ParseFloat(strings.TrimSpace(valueString(value)), 64)
		if err != nil || number <= 0 || number != float64(int(number)) {
			return fallback
		}
		return int(number)
	}
	return parse(raw["pageNum"], 1), parse(raw["pageSize"], 20)
}

func resolveAdminUserOrder(rawColumns, rawDirections any) ([]adminOrder, error) {
	columnsText := strings.TrimSpace(valueString(rawColumns))
	directionsText := strings.TrimSpace(valueString(rawDirections))
	if columnsText == "" || directionsText == "" {
		return []adminOrder{{Field: user.FieldUpdatedAt}, {Field: user.FieldID}}, nil
	}
	for _, char := range columnsText {
		if !((char >= '0' && char <= '9') || (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char == '_' || char == ',') {
			return nil, response.BadRequest("排序参数有误")
		}
	}
	columnParts := strings.Split(columnsText, ",")
	directionParts := strings.Split(strings.NewReplacer("ascending", "asc", "descending", "desc").Replace(directionsText), ",")
	if len(directionParts) != 1 && len(directionParts) != len(columnParts) {
		return nil, response.BadRequest("排序参数有误")
	}
	orders := make([]adminOrder, 0, len(columnParts))
	for index, rawColumn := range columnParts {
		field, ok := adminOrderFields[toSnakeCase(strings.TrimSpace(rawColumn))]
		if !ok {
			return nil, response.BadRequest("排序参数有误")
		}
		direction := strings.ToLower(strings.TrimSpace(directionParts[0]))
		if len(directionParts) > 1 {
			direction = strings.ToLower(strings.TrimSpace(directionParts[index]))
		}
		if direction != "asc" && direction != "desc" {
			return nil, response.BadRequest("排序参数有误")
		}
		orders = append(orders, adminOrder{Field: field, Ascending: direction == "asc"})
	}
	return orders, nil
}

func toSnakeCase(value string) string {
	var output strings.Builder
	for index, char := range value {
		if char >= 'A' && char <= 'Z' {
			if index > 0 {
				output.WriteByte('_')
			}
			output.WriteRune(char + ('a' - 'A'))
		} else {
			output.WriteRune(char)
		}
	}
	return output.String()
}

func valueString(value any) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
