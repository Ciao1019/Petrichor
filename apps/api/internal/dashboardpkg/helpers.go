// helpers.go dashboardpkg 小工具。
package dashboardpkg

import (
	"encoding/json"
	"strconv"
	"strings"
)

func itoa(n int) string { return strconv.Itoa(n) }

func itoa64(n int64) string { return strconv.FormatInt(n, 10) }

func trimSpaces(s string) string { return strings.TrimSpace(s) }

func jsonUnmarshal(data []byte, target any) error {
	return json.Unmarshal(data, target)
}

func firstOr(days []string, fallback string) string {
	if len(days) > 0 {
		return days[0]
	}
	return fallback
}

func lastOr(days []string, fallback string) string {
	if len(days) > 0 {
		return days[len(days)-1]
	}
	return fallback
}

// rowScanner 抽象 pgx.Rows 以便 collectRows 做泛型收集。
type rowScanner interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close()
}
