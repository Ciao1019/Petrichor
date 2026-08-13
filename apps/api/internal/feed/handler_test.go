package feed

import (
	"testing"

	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
)

func TestEscapeXMLMatchesLegacyContract(t *testing.T) {
	got := escapeXML(`A&B <tag> "quote" 'single'`)
	want := `A&amp;B &lt;tag&gt; &quot;quote&quot; &apos;single&apos;`
	if got != want {
		t.Fatalf("escapeXML() = %q, want %q", got, want)
	}
}

func TestBaseURLDropsConfiguredPath(t *testing.T) {
	handler := NewHandler(nil, &config.Config{AppURL: "https://petrichor.example/path/"})
	if got := handler.baseURL(); got != "https://petrichor.example" {
		t.Fatalf("baseURL() = %q", got)
	}
}
