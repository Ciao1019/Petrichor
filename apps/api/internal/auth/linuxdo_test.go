package auth

import (
	"strings"
	"testing"
)

func TestLinuxDoUserUpdateUsesUserIDArgument(t *testing.T) {
	if !strings.Contains(linuxDoUserUpdateQuery, "WHERE id = $7") {
		t.Fatalf("LinuxDo 用户更新必须使用第 7 个参数匹配用户: %s", linuxDoUserUpdateQuery)
	}
}
