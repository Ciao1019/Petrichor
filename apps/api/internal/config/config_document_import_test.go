package config

import (
	"testing"
	"time"
)

func TestDocumentImportDefaultConfig(t *testing.T) {
	cfg, err := normalizeDocumentImport(documentImportFileConfig{})
	if err != nil || cfg.Parser.Command != "petrichor-doc-convert" || cfg.Parser.Timeout != 5*time.Minute {
		t.Fatalf("%+v %v", cfg, err)
	}
}
