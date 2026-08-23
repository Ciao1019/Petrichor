// helpers.go sitecontent 包内的小工具：错误分类与标量转换。
package sitecontent

import (
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// isUndefinedTableErr 判断是否 42P01（表不存在，增量迁移未执行）。
func isUndefinedTableErr(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "42P01"
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "42p01") ||
		(strings.Contains(msg, "does not exist") && strings.Contains(msg, "relation"))
}

func strconvFormatInt(n int64) string { return strconv.FormatInt(n, 10) }

func trimFloat(v float64) string {
	s := strconv.FormatFloat(v, 'f', -1, 64)
	return s
}

// oneLine 单行文本：折叠换行/首尾空白为一个空格。
func oneLine(raw any) string {
	value := anyToString(raw)
	lines := strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			kept = append(kept, trimmed)
		}
	}
	return strings.TrimSpace(strings.Join(kept, " "))
}

// multiLine 多行文本：保留段落换行，仅裁剪每行首尾空白。
func multiLine(raw any) string {
	value := anyToString(raw)
	lines := strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSpace(line)
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}
