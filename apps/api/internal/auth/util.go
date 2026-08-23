package auth

import (
	"context"
	"strings"
)

func ctx() context.Context { return context.Background() }

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
