package documentparse

import (
	"bytes"
	"encoding/json"
	"io"
	"strconv"
	"unicode/utf8"
)

// JSON 对控制字符的转义最多膨胀六倍；正文限制仍单独按 UTF-8 字节计算。
const maxConverterOutput = maxMarkdownUnit*6 + (64 << 10)

type conversion struct {
	markdown *string
	needsOCR bool
	visuals  *pdfVisuals
}

func (p *preparation) convert(input, format, dir string) (conversion, error) {
	if err := p.ctx.Err(); err != nil {
		return conversion{}, err
	}
	data, err := p.runner.run(p.ctx, p.cfg.Command, dir, []string{"--input", input, "--format", format}, maxConverterOutput)
	if err != nil {
		return conversion{}, err
	}
	if err := p.ctx.Err(); err != nil {
		return conversion{}, err
	}
	return parseConversion(data)
}

func parseConversion(data []byte) (conversion, error) {
	bad := func() (conversion, error) { return conversion{}, failure(CodeProtocol) }
	if len(data) > maxConverterOutput {
		return conversion{}, failure(CodeResourceLimit)
	}
	if !utf8.Valid(data) {
		return bad()
	}
	// 手动读取顶层键，既拒绝未知字段，也拒绝 encoding/json 默认接受的重复键。
	dec := json.NewDecoder(bytes.NewReader(data))
	token, err := dec.Token()
	if err != nil || token != json.Delim('{') {
		return bad()
	}
	fields := map[string]json.RawMessage{}
	for dec.More() {
		token, err := dec.Token()
		if err != nil {
			return bad()
		}
		key, ok := token.(string)
		if !ok || fields[key] != nil {
			return bad()
		}
		switch key {
		case "ok", "markdown", "engine", "code", "pages", "pageCount", "visuals":
		default:
			return bad()
		}
		var raw json.RawMessage
		if dec.Decode(&raw) != nil || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return bad()
		}
		fields[key] = raw
	}
	if token, err = dec.Token(); err != nil || token != json.Delim('}') {
		return bad()
	}
	if _, err = dec.Token(); err != io.EOF {
		return bad()
	}
	var ok bool
	if fields["ok"] == nil || json.Unmarshal(fields["ok"], &ok) != nil {
		return bad()
	}
	if ok {
		if (len(fields) != 3 && len(fields) != 4) || fields["markdown"] == nil || fields["engine"] == nil || fields["code"] != nil || fields["pages"] != nil || fields["pageCount"] != nil {
			return bad()
		}
		text, valid := strictString(fields["markdown"])
		engine, engineValid := strictString(fields["engine"])
		if !valid || !engineValid || (engine != "anydoc" && engine != "calamine") {
			return bad()
		}
		if len(text) > maxMarkdownUnit {
			return conversion{}, failure(CodeResourceLimit)
		}
		var visuals *pdfVisuals
		if raw := fields["visuals"]; raw != nil {
			visuals, err = parsePDFVisuals(raw)
			if err != nil {
				return bad()
			}
		}
		return conversion{markdown: &text, visuals: visuals}, nil
	}
	if fields["markdown"] != nil || fields["engine"] != nil || fields["visuals"] != nil {
		return bad()
	}
	code, valid := strictString(fields["code"])
	if !valid {
		return bad()
	}
	var pages []int
	var pageCount int
	if raw := fields["pages"]; raw != nil {
		if json.Unmarshal(raw, &pages) != nil {
			return bad()
		}
		for _, page := range pages {
			if page < 1 {
				return bad()
			}
		}
	}
	if raw := fields["pageCount"]; raw != nil {
		if json.Unmarshal(raw, &pageCount) != nil || pageCount < 0 {
			return bad()
		}
	}
	switch code {
	case "needsOcr":
		// 仅信任对已拆分单页的明确结论，不能把不支持、损坏或不完整信息当作 OCR。
		if len(pages) != 1 || pages[0] != 1 || pageCount != 1 {
			return bad()
		}
		return conversion{needsOCR: true}, nil
	case CodeUnsupported, CodeMalformed, CodeEncrypted, CodeResourceLimit, CodeMissingPart, CodeIO:
		return conversion{}, failure(code)
	default:
		return bad()
	}
}

func strictString(raw []byte) (string, bool) {
	var s string
	if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &s) != nil {
		return "", false
	}
	// encoding/json 会替换孤立的 UTF-16 代理项；协议不允许悄悄修复错误文本。
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		u, err := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		if err != nil {
			return "", false
		}
		i += 4
		if u >= 0xdc00 && u <= 0xdfff {
			return "", false
		}
		if u >= 0xd800 && u <= 0xdbff {
			if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
				return "", false
			}
			low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return "", false
			}
			i += 6
		}
	}
	return s, true
}
