package assistant

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

type ctxKeyUserID struct{}
type ctxKeyThreadID struct{}
type ctxKeyRunID struct{}
type ctxKeyClient struct{}
type ctxKeyFocus struct{}
type ctxKeySystemRole struct{}
type ctxKeyCfg struct{}
type ctxKeyConfirmExec struct{}
type ctxKeySpawnDepth struct{}

type spawnDepthValue struct {
	Depth int
}

// ToolContext 工具执行上下文。
type ToolContext struct {
	UserID      int64
	ThreadID    int64
	RunID       int64
	Focus       *AssistantFocus
	SystemRole  string
	ConfirmExec bool
	SpawnDepth  *int
}

func withToolContext(base context.Context, tc ToolContext, client *ent.Client, cfg *config.Config) context.Context {
	ctx := withUserID(base, tc.UserID)
	ctx = withThreadID(ctx, tc.ThreadID)
	ctx = withRunID(ctx, tc.RunID)
	ctx = withClient(ctx, client)
	if tc.Focus != nil {
		ctx = context.WithValue(ctx, ctxKeyFocus{}, tc.Focus)
	}
	if tc.SystemRole != "" {
		ctx = context.WithValue(ctx, ctxKeySystemRole{}, tc.SystemRole)
	}
	if cfg != nil {
		ctx = context.WithValue(ctx, ctxKeyCfg{}, cfg)
	}
	if tc.ConfirmExec {
		ctx = context.WithValue(ctx, ctxKeyConfirmExec{}, true)
	}
	if tc.SpawnDepth != nil {
		ctx = context.WithValue(ctx, ctxKeySpawnDepth{}, spawnDepthValue{Depth: *tc.SpawnDepth})
	}
	return ctx
}

func withUserID(ctx context.Context, userID int64) context.Context {
	return context.WithValue(ctx, ctxKeyUserID{}, userID)
}

func userIDFrom(ctx context.Context) (int64, error) {
	v := ctx.Value(ctxKeyUserID{})
	id, ok := v.(int64)
	if !ok || id <= 0 {
		return 0, fmt.Errorf("缺少 userID")
	}
	return id, nil
}

func withThreadID(ctx context.Context, threadID int64) context.Context {
	return context.WithValue(ctx, ctxKeyThreadID{}, threadID)
}

func threadIDFrom(ctx context.Context) int64 {
	v, _ := ctx.Value(ctxKeyThreadID{}).(int64)
	return v
}

func withRunID(ctx context.Context, runID int64) context.Context {
	return context.WithValue(ctx, ctxKeyRunID{}, runID)
}

func runIDFrom(ctx context.Context) int64 {
	v, _ := ctx.Value(ctxKeyRunID{}).(int64)
	return v
}

func withClient(ctx context.Context, client *ent.Client) context.Context {
	return context.WithValue(ctx, ctxKeyClient{}, client)
}

func clientFrom(ctx context.Context) (*ent.Client, error) {
	v := ctx.Value(ctxKeyClient{})
	c, ok := v.(*ent.Client)
	if !ok || c == nil {
		return nil, fmt.Errorf("缺少数据库客户端")
	}
	return c, nil
}

func focusFrom(ctx context.Context) *AssistantFocus {
	v, _ := ctx.Value(ctxKeyFocus{}).(*AssistantFocus)
	return v
}

func systemRoleFrom(ctx context.Context) string {
	v, _ := ctx.Value(ctxKeySystemRole{}).(string)
	return v
}

func cfgFrom(ctx context.Context) *config.Config {
	v, _ := ctx.Value(ctxKeyCfg{}).(*config.Config)
	return v
}

func confirmExecFrom(ctx context.Context) bool {
	v, _ := ctx.Value(ctxKeyConfirmExec{}).(bool)
	return v
}

func spawnDepthFrom(ctx context.Context) (int, bool) {
	v, ok := ctx.Value(ctxKeySpawnDepth{}).(spawnDepthValue)
	if !ok {
		return 0, false
	}
	return v.Depth, true
}

func parsePositiveID(raw, field string) (int64, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, fmt.Errorf("%s 无效", field)
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0, fmt.Errorf("%s 无效", field)
		}
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("%s 无效", field)
	}
	return id, nil
}

func focusID(value *string) (int64, bool) {
	if value == nil || strings.TrimSpace(*value) == "" {
		return 0, false
	}
	id, err := parsePositiveID(*value, "focusId")
	if err != nil {
		return 0, false
	}
	return id, true
}

func isSuperAdmin(role string) bool {
	return role == "SUPER_ADMIN"
}

func isOperator(role string) bool {
	return role == "SUPER_ADMIN" || role == "OPERATOR"
}
