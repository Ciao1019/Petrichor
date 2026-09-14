package documentparse

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestPopplerPasswordDiagnosticSubprocess(t *testing.T) {
	const diagnostic = "Command Line Error: Incorrect password"
	for _, test := range []struct {
		name, stderr, code string
		exit               int
	}{
		{"open-password", diagnostic + "\n", CodeEncrypted, 1},
		{"crlf", diagnostic + "\r\n", CodeEncrypted, 1},
		{"no-newline", diagnostic, CodeEncrypted, 1},
		{"other-private-output", "/private/source.pdf: secret contents\n" + diagnostic + "\n", CodeEncrypted, 1},
		{"malformed", "Syntax Error: invalid xref in /private/source.pdf\n", CodeMalformed, 1},
		{"missing", "I/O Error: Couldn't open file /private/source.pdf\n", CodeMalformed, 1},
		{"empty", "", CodeMalformed, 1},
		{"partial", "Incorrect password\n", CodeMalformed, 1},
		{"path-prefix", "/private/" + diagnostic + "\n", CodeMalformed, 1},
		{"path-suffix", diagnostic + ": /private/source.pdf\n", CodeMalformed, 1},
		{"other-exit", diagnostic + "\n", CodeMalformed, 99},
		{"unknown-exit", diagnostic + "\n", CodeCommandFailed, 7},
		{"bounded-stderr", diagnostic + "\n" + strings.Repeat("secret", maxStderrBytes), CodeResourceLimit, 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := "printf '%s' '" + strings.ReplaceAll(test.stderr, "'", "'\\''") + "' >&2\n" + fmt.Sprintf("exit %d", test.exit)
			path, _ := fakeBinary(t, body)
			dir := t.TempDir()
			calls := 0
			runner := runnerFunc(func(ctx context.Context, command, work string, args []string, limit int) ([]byte, error) {
				calls++
				if command != "pdfinfo" {
					t.Fatal("探测失败后仍调用了后续工具")
				}
				return (execRunner{}).run(ctx, path, work, args, limit)
			})
			err := prepare(context.Background(), Config{}, "private.pdf", []byte("pdf"), dir, nil, noEmit(t), runner)
			mustCode(t, err, test.code)
			if calls != 1 {
				t.Fatalf("pdfinfo 调用次数: %d", calls)
			}
			mustClean(t, dir)
		})
	}
}
