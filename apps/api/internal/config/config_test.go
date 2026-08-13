package config

import "testing"

func TestLoadAppURLUsesConfiguredValue(t *testing.T) {
	t.Setenv("APP_BASE_URL", "https://petrichor.example/base")
	if got := loadAppURL(); got != "https://petrichor.example/base" {
		t.Fatalf("loadAppURL() = %q", got)
	}

	t.Setenv("APP_BASE_URL", "")
	if got := loadAppURL(); got != "http://localhost:3000" {
		t.Fatalf("loadAppURL() default = %q", got)
	}
}
