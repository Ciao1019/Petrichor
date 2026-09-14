package config

import (
	"fmt"
	"strings"
	"time"
)

type DocumentImportConfig struct {
	Parser DocumentParserConfig
}

type DocumentParserConfig struct {
	Command string
	Timeout time.Duration
}

type documentImportFileConfig struct {
	Parser struct {
		Command        string `toml:"command"`
		TimeoutSeconds int    `toml:"timeout_seconds"`
	} `toml:"parser"`
}

func normalizeDocumentImport(raw documentImportFileConfig) (DocumentImportConfig, error) {
	parser := DocumentParserConfig{Command: strings.TrimSpace(raw.Parser.Command)}
	if parser.Command == "" {
		parser.Command = "petrichor-doc-convert"
	}
	if strings.ContainsAny(parser.Command, "\x00\r\n") {
		return DocumentImportConfig{}, fmt.Errorf("document_import.parser.command 无效")
	}
	parserSeconds := raw.Parser.TimeoutSeconds
	if parserSeconds == 0 {
		parserSeconds = 300
	}
	if parserSeconds < 1 || parserSeconds > 1800 {
		return DocumentImportConfig{}, fmt.Errorf("document_import.parser.timeout_seconds 必须在 1 到 1800 之间")
	}
	parser.Timeout = time.Duration(parserSeconds) * time.Second
	return DocumentImportConfig{Parser: parser}, nil
}
