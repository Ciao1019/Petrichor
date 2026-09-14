package documentparse

import (
	"bytes"
	"strings"
	"testing"
)

func TestConversionStrictProtocol(t *testing.T) {
	for _, data := range []string{
		``, `[]`, `null`, `{}`, `{"ok":"true","markdown":"x","engine":"anydoc"}`,
		`{"ok":true,"markdown":null,"engine":"anydoc"}`,
		`{"ok":true,"markdown":"x"}`,
		`{"ok":true,"markdown":"x","engine":"other"}`,
		`{"ok":true,"markdown":"x","engine":"anydoc","extra":1}`,
		`{"ok":true,"ok":true,"markdown":"x","engine":"anydoc"}`,
		`{"ok":true,"markdown":"x","engine":"anydoc"} {"ok":false}`,
		`{"ok":true,"markdown":"x","engine":"anydoc"}garbage`,
		`{"ok":true,"markdown":"\ud800","engine":"anydoc"}`,
		`{"ok":true,"markdown":"\udc00","engine":"anydoc"}`,
		`{"ok":false}`, `{"ok":false,"code":"unknown"}`,
		`{"ok":false,"code":"malformed","markdown":""}`,
		`{"ok":false,"code":"malformed","engine":"anydoc"}`,
		`{"ok":false,"code":"needsOcr"}`,
		`{"ok":false,"code":"needsOcr","pages":[1]}`,
		`{"ok":false,"code":"needsOcr","pages":[1],"pageCount":2}`,
		`{"ok":false,"code":"needsOcr","pages":[1,2],"pageCount":1}`,
		`{"ok":false,"code":"needsOcr","pages":[2],"pageCount":1}`,
		`{"ok":false,"code":"needsOcr","pages":null,"pageCount":1}`,
		`{"ok":false,"code":"needsOcr","pages":[1],"pageCount":1.0}`,
		`{"ok":false,"code":"malformed","pages":[0],"pageCount":1}`,
		`{"ok":false,"code":"malformed","pages":[1],"pageCount":-1}`,
		"{\"ok\":true,\"markdown\":\"\xff\",\"engine\":\"anydoc\"}",
	} {
		t.Run(data, func(t *testing.T) {
			_, err := parseConversion([]byte(data))
			mustCode(t, err, CodeProtocol)
		})
	}
	for _, engine := range []string{"anydoc", "calamine"} {
		got, err := parseConversion([]byte(` {"ok":true,"markdown":"\ud83d\ude00\\u1234\n ","engine":"` + engine + `"} `))
		if err != nil || got.markdown == nil || *got.markdown != "😀\\u1234\n " || got.needsOCR {
			t.Fatalf("合法转义: %+v %v", got, err)
		}
	}
	got, err := parseConversion([]byte(`{"ok":true,"markdown":"","engine":"anydoc"}`))
	if err != nil || got.markdown == nil || *got.markdown != "" || got.needsOCR {
		t.Fatalf("结构空白必须 direct: %+v %v", got, err)
	}
	got, err = parseConversion([]byte(`{"ok":false,"code":"needsOcr","pages":[1],"pageCount":1}`))
	if err != nil || got.markdown != nil || !got.needsOCR {
		t.Fatalf("明确单页 OCR: %+v %v", got, err)
	}
}

func TestConversionBusinessErrors(t *testing.T) {
	for _, code := range []string{CodeMalformed, CodeEncrypted, CodeUnsupported, CodeResourceLimit, CodeMissingPart, CodeIO} {
		for _, metadata := range []string{"", `,"pages":[1],"pageCount":1`} {
			got, err := parseConversion([]byte(`{"ok":false,"code":"` + code + `"` + metadata + `}`))
			mustCode(t, err, code)
			if got.needsOCR || got.markdown != nil {
				t.Fatalf("业务失败不得 OCR: %+v", got)
			}
		}
	}
}

func TestConversionOutputLimits(t *testing.T) {
	for _, text := range []string{strings.Repeat("x", maxMarkdownUnit), strings.Repeat("\x00", maxMarkdownUnit)} {
		got, err := parseConversion(successful(text))
		if err != nil || got.markdown == nil || *got.markdown != text {
			t.Fatalf("2MiB（包含 JSON 转义）边界: %v", err)
		}
	}
	_, err := parseConversion(successful(strings.Repeat("x", maxMarkdownUnit+1)))
	mustCode(t, err, CodeResourceLimit)
	_, err = parseConversion(bytes.Repeat([]byte(" "), maxConverterOutput+1))
	mustCode(t, err, CodeResourceLimit)
}
