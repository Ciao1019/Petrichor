package httpx

import (
	"fmt"
	"strconv"
	"strings"

	json "github.com/json-iterator/go"
)

// FlexID 兼容字符串或数字形式的正整数 ID（对应 zod 的 string|number 联合校验）。
type FlexID int64

func (f *FlexID) UnmarshalJSON(data []byte) error {
	s := strings.TrimSpace(string(data))
	if s == "null" {
		return BadRequest("ID 必须是正整数")
	}
	unquoted, err := strconv.Unquote(s)
	if err == nil {
		s = unquoted
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return BadRequest("ID 必须是正整数")
	}
	*f = FlexID(n)
	return nil
}

func (f FlexID) Int64() int64 { return int64(f) }

// FlexString 接受任意 JSON 标量后转为字符串（部分接口允许数字形式输入）。
type FlexString string

func (s *FlexString) UnmarshalJSON(data []byte) error {
	var str string
	if err := json.Unmarshal(data, &str); err == nil {
		*s = FlexString(str)
		return nil
	}
	var num float64
	if err := json.Unmarshal(data, &num); err == nil {
		*s = FlexString(strconv.FormatFloat(num, 'f', -1, 64))
		return nil
	}
	var b bool
	if err := json.Unmarshal(data, &b); err == nil {
		*s = FlexString(strconv.FormatBool(b))
		return nil
	}
	return fmt.Errorf("字段类型不支持")
}

func (s FlexString) String() string { return string(s) }

// Trimmed 去除首尾空格。
func (s FlexString) Trimmed() string { return strings.TrimSpace(string(s)) }
