package auth

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

func TestProfileDTOKeepsLegacyNullableFields(t *testing.T) {
	now := time.Date(2026, 8, 12, 1, 2, 3, 0, time.UTC)
	u := &ent.User{
		ID: 1, Email: "user@example.com", SystemRole: "USER", UserType: "LOCAL",
		CreatedAt: now, UpdatedAt: now,
	}

	profileJSON, err := json.Marshal(ToProfileDTO(u))
	if err != nil {
		t.Fatal(err)
	}
	var profile map[string]any
	if err := json.Unmarshal(profileJSON, &profile); err != nil {
		t.Fatal(err)
	}
	if value, exists := profile["signature"]; !exists || value != nil {
		t.Fatalf("signature should be explicit null: %#v", profile)
	}
	userJSON, err := json.Marshal(ToUserDTO(u))
	if err != nil {
		t.Fatal(err)
	}
	var userPayload map[string]any
	if err := json.Unmarshal(userJSON, &userPayload); err != nil {
		t.Fatal(err)
	}
	if _, exists := userPayload["signature"]; exists {
		t.Fatalf("basic user response leaked profile-only fields: %#v", userPayload)
	}
}

func TestUpdateProfileRequestDistinguishesMissingAndNull(t *testing.T) {
	var req updateProfileRequest
	if err := json.Unmarshal([]byte(`{"nickname":null,"avatar":" https://example.com/a.png "}`), &req); err != nil {
		t.Fatal(err)
	}
	if !req.Nickname.Present || req.Nickname.Value != nil {
		t.Fatalf("nickname null was not preserved: %#v", req.Nickname)
	}
	if !req.Avatar.Present || req.Avatar.Value == nil || *req.Avatar.Value != " https://example.com/a.png " {
		t.Fatalf("avatar value was not preserved: %#v", req.Avatar)
	}
	if req.Signature.Present {
		t.Fatalf("missing signature should stay absent: %#v", req.Signature)
	}
}

func TestLinuxDoFrontendURLDropsConfiguredPath(t *testing.T) {
	h := &Handler{cfg: &config.Config{AppURL: "https://petrichor.example/base/?old=1#fragment"}}
	if got := h.linuxDoFrontendURL("/dashboard/account").String(); got != "https://petrichor.example/dashboard/account" {
		t.Fatalf("linuxDoFrontendURL() = %q", got)
	}
	if got := h.linuxDoRedirectURI(); got != "https://petrichor.example/api/auth/callback" {
		t.Fatalf("linuxDoRedirectURI() = %q", got)
	}
}

func TestNormalizeLinuxDoUserInfoMatchesLegacyRules(t *testing.T) {
	info := normalizeLinuxDoUserInfo(map[string]any{
		"id": float64(123), "username": "Neo", "name": "", "avatar_url": "https://example.com/a.png",
	})
	if info.AccountID != "123" || info.Email != "Neo@linux.do" || info.Nickname == nil || *info.Nickname != "Neo" {
		t.Fatalf("unexpected normalized user: %#v", info)
	}

	ignored := readLinuxDoString(map[string]any{"id": true}, "id")
	if ignored != nil {
		t.Fatalf("non-string/non-number value should be ignored: %q", *ignored)
	}
	decimal := readLinuxDoString(map[string]any{"id": float64(123.5)}, "id")
	if decimal == nil || *decimal != "123.5" {
		t.Fatalf("numeric value should preserve its decimal representation: %#v", decimal)
	}
}

func TestLegacyRoleAndUserTypeNormalization(t *testing.T) {
	if got := NormalizeSystemRole("", 1); got != "SUPER_ADMIN" {
		t.Fatalf("legacy first user role = %q", got)
	}
	if got := NormalizeSystemRole(" ", 2); got != "USER" {
		t.Fatalf("blank non-first role = %q", got)
	}
	if got := NormalizeUserType("", "hash"); got != "LOCAL" {
		t.Fatalf("password user type = %q", got)
	}
	if got := NormalizeUserType("", ""); got != "LINUXDO" {
		t.Fatalf("passwordless user type = %q", got)
	}
}
