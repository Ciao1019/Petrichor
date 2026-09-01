package auth

import "strings"

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}
