package ai_test

import (
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
)

func TestEmbeddingDimensionsConstant(t *testing.T) {
	if ai.EmbeddingDimensions != 1024 {
		t.Fatalf("EmbeddingDimensions = %d, want 1024", ai.EmbeddingDimensions)
	}
}
