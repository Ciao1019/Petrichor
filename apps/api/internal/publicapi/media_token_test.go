package publicapi

import (
	"strings"
	"testing"
)

func TestMediaAccessTokenRoundTrip(t *testing.T) {
	token, err := issueMediaAccessToken(mediaKindArticle, 42)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	claims, err := verifyMediaAccessToken(token)
	if err != nil {
		t.Fatalf("verify token: %v", err)
	}
	if claims.Kind != mediaKindArticle || claims.ID != 42 {
		t.Fatalf("claims = %#v", claims)
	}
}

func TestMediaAccessTokenRejectsTampering(t *testing.T) {
	token, err := issueMediaAccessToken(mediaKindWiki, 9)
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		t.Fatalf("token format = %q", token)
	}
	parts[0] = "e30"
	if _, err := verifyMediaAccessToken(strings.Join(parts, ".")); err == nil {
		t.Fatal("tampered token was accepted")
	}
}

func TestIssueMediaAccessTokenRejectsInvalidScope(t *testing.T) {
	if _, err := issueMediaAccessToken("private", 1); err == nil {
		t.Fatal("unknown scope was accepted")
	}
	if _, err := issueMediaAccessToken(mediaKindArticle, 0); err == nil {
		t.Fatal("zero id was accepted")
	}
}
