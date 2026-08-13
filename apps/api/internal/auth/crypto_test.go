package auth

import "testing"

func TestNormalizeEmail(t *testing.T) {
	got := NormalizeEmail("  Foo@Example.COM ")
	if got != "foo@example.com" {
		t.Fatalf("unexpected email: %s", got)
	}
}

func TestPasswordHashRoundTrip(t *testing.T) {
	hash, err := HashPassword("secret-pass")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(hash, "secret-pass") {
		t.Fatal("expected password match")
	}
	if CheckPassword(hash, "wrong") {
		t.Fatal("expected password mismatch")
	}
}

func TestSessionTokenHashStable(t *testing.T) {
	token, err := IssueSessionToken()
	if err != nil {
		t.Fatal(err)
	}
	if HashSessionToken(token) != HashSessionToken(token) {
		t.Fatal("hash should be stable")
	}
	if HashSessionToken(token) == HashSessionToken(token+"x") {
		t.Fatal("different tokens should hash differently")
	}
}
