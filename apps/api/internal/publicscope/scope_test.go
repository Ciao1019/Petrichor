package publicscope

import (
	"strings"
	"testing"
)

func TestShareVisibilityWhereCoversAnonymousVisibilityMatrix(t *testing.T) {
	required := []string{
		"s.enabled = true",
		"s.revoked_at IS NULL",
		"s.password_hash IS NULL",
		"s.expires_at > now()",
		"s.share_code",
	}
	for _, fragment := range required {
		if !strings.Contains(ShareVisibilityWhere, fragment) {
			t.Fatalf("公开文章作用域缺少条件 %q: %s", fragment, ShareVisibilityWhere)
		}
	}
}

func TestSafeWikiScopeRequiresEverySourceToBePublic(t *testing.T) {
	required := []string{
		"p.archived_at IS NULL",
		"p.kind NOT IN ('index', 'log')",
		"AND EXISTS (",
		"AND NOT EXISTS (",
		"s.article_id IS NULL",
		ShareVisibilityWhere,
	}
	for _, fragment := range required {
		if !strings.Contains(safeWikiPageIDsQuery, fragment) {
			t.Fatalf("安全 Wiki 作用域缺少条件 %q", fragment)
		}
	}
}
