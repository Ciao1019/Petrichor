package vector_test

import (
	"strings"
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/internal/vector"
)

func TestBuildDocumentEmbedTextUsesRunes(t *testing.T) {
	got := vector.BuildDocumentEmbedText("标题", strings.Repeat("知", vector.DocumentEmbedMaxChars+20))
	if len([]rune(got)) != vector.DocumentEmbedMaxChars {
		t.Fatalf("runes = %d", len([]rune(got)))
	}
}
