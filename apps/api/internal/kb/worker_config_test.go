package kb

import (
	"testing"

	"petrichor/api/internal/config"
)

func TestBackgroundWorkerConcurrencyLimits(t *testing.T) {
	if config.DefaultKnowledgeBuildConcurrency != 8 {
		t.Fatalf("default knowledge article concurrency = %d, want 8", config.DefaultKnowledgeBuildConcurrency)
	}
	if config.DefaultKnowledgeBuildModelConcurrency != 64 {
		t.Fatalf("default knowledge model concurrency = %d, want 64", config.DefaultKnowledgeBuildModelConcurrency)
	}
	if visionImportWorkerConcurrency*visionImportPageConcurrency > 2 {
		t.Fatalf("vision model concurrency = %d, want <= 2", visionImportWorkerConcurrency*visionImportPageConcurrency)
	}
}
