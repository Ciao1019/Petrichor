// markdown.go 复刻 share-logic.ts 的正文派生逻辑：摘要、阅读时长与 TOC。
package publicapi

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var (
	fenceRe     = regexp.MustCompile("(?s)```.*?```")
	inlineCode  = regexp.MustCompile("`([^`]+)`")
	mdImageRe   = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLinkText  = regexp.MustCompile(`\[([^\]]+)]\([^)]*\)`)
	headStrip   = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	quoteStrip  = regexp.MustCompile(`(?m)^>\s?`)
	mdSymbolRe  = regexp.MustCompile("[*_~#>`\\-]+")
	spaceRe     = regexp.MustCompile("\\s+")
	headingRe   = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*$`)
	fenceLineRe = regexp.MustCompile(`^\s*(` + "`" + `{3}|~{3})`)
)

// markdownToPlainText 摘要与阅读时长共用的纯文本归一化。
func markdownToPlainText(contentMd string) string {
	text := fenceRe.ReplaceAllString(contentMd, " ")
	text = inlineCode.ReplaceAllString(text, "$1")
	text = mdImageRe.ReplaceAllString(text, " ")
	text = mdLinkText.ReplaceAllString(text, "$1")
	text = headStrip.ReplaceAllString(text, "")
	text = quoteStrip.ReplaceAllString(text, "")
	text = mdSymbolRe.ReplaceAllString(text, " ")
	text = spaceRe.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}

// buildHomepageArticleExcerpt 对应 share-logic.ts 同名函数。
func buildHomepageArticleExcerpt(contentMd string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = 120
	}
	text := markdownToPlainText(contentMd)
	if text == "" {
		return "暂无摘要"
	}
	runes := []rune(text)
	if len(runes) <= maxLength {
		return text
	}
	return strings.TrimRight(string(runes[:maxLength]), " \t\n\r") + "..."
}

// estimateReadingMinutes CJK 字符数 + 拉丁词数，除以 420 向上取整。
func estimateReadingMinutes(contentMd string) int32 {
	text := markdownToPlainText(contentMd)
	if text == "" {
		return 1
	}
	cjkCount := 0
	for _, r := range text {
		if r >= 0x4e00 && r <= 0x9fff {
			cjkCount++
		}
	}
	stripped := regexp.MustCompile("[\\x{4e00}-\\x{9fff}]").ReplaceAllString(text, " ")
	latinWords := len(strings.Fields(stripped))
	minutes := (cjkCount + latinWords + 419) / 420
	if minutes < 1 {
		minutes = 1
	}
	return int32(minutes)
}

func contentMD5(v string) string {
	sum := md5.Sum([]byte(v))
	return hex.EncodeToString(sum[:])
}

type tocItem struct {
	ID    string `json:"id"`
	Level int32  `json:"level"`
	Text  string `json:"text"`
}

var (
	tocSlugSpace    = regexp.MustCompile(`\s+`)
	inlineMdCleanup = regexp.MustCompile("[*_~`\\[\\]]")
	tocSlugKeepRune = func(r rune) bool {
		return unicode.IsLetter(r) || unicode.IsDigit(r) || r == ' ' || r == '-' || r == '_'
	}
	tocInlineCodeStrip = regexp.MustCompile("`([^`]+)`")
)

// slugger 复刻 github-slugger 的去重行为：重复标题追加 -1、-2 …
type slugger struct {
	seen map[string]int
}

func newSlugger() *slugger { return &slugger{seen: map[string]int{}} }

func (s *slugger) slug(text string) string {
	lowered := strings.ToLower(strings.TrimSpace(text))
	var b strings.Builder
	for _, r := range lowered {
		if !tocSlugKeepRune(r) {
			continue
		}
		b.WriteRune(r)
	}
	base := tocSlugSpace.ReplaceAllString(strings.Trim(b.String(), " "), "-")
	if base == "" {
		base = "heading"
	}
	if count, ok := s.seen[base]; ok {
		s.seen[base] = count + 1
		return base + "-" + strconvItoa(count)
	}
	s.seen[base] = 0
	return base
}

func strconvItoa(n int) string { return strconv.Itoa(n) }

// buildToc 简化版 Markdown TOC：按行扫描标题（围栏感知），slug 去重与 TS 版对齐。
// 偏差：TS 用 marked 词法器，行内标记清理更彻底；本实现做基础行内符号清理。
func buildToc(markdown string) []tocItem {
	if markdown == "" {
		return []tocItem{}
	}
	out := []tocItem{}
	sg := newSlugger()
	inFence := false
	for _, line := range strings.Split(markdown, "\n") {
		if fenceLineRe.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		m := headingRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		stripped := tocInlineCodeStrip.ReplaceAllString(m[2], "$1")
		text := strings.TrimSpace(spaceRe.ReplaceAllString(inlineMdCleanup.ReplaceAllString(stripped, ""), " "))
		if text == "" {
			continue
		}
		out = append(out, tocItem{ID: sg.slug(text), Level: int32(len(m[1])), Text: text})
	}
	return out
}

// parseStoredTocJSON 对应 parsePublicArticleTocJson：非法条目剔除，整体非法返回 nil。
func parseStoredTocJSON(raw *string) []tocItem {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return nil
	}
	arr, ok := parsed.([]any)
	if !ok {
		return nil
	}
	out := []tocItem{}
	for _, item := range arr {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id := strings.TrimSpace(toStr(record["id"]))
		text := strings.TrimSpace(toStr(record["text"]))
		level := 0
		if lv, ok := record["level"].(float64); ok && lv == float64(int64(lv)) {
			level = int(lv)
		}
		if id == "" || text == "" || level < 1 || level > 6 {
			continue
		}
		out = append(out, tocItem{ID: id, Level: int32(level), Text: text})
	}
	return out
}

// resolvePublicArticleToc 存储哈希与当前内容一致时用存量 TOC，否则现场重建。
func resolvePublicArticleToc(contentMd string, tocJSON *string, publicContentHash *string) []tocItem {
	currentHash := contentMD5(contentMd)
	if publicContentHash != nil && *publicContentHash == currentHash {
		if stored := parseStoredTocJSON(tocJSON); stored != nil {
			return stored
		}
	}
	return buildToc(contentMd)
}
