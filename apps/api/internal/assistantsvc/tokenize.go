package assistantsvc

import (
	"strings"
	"unicode"
)

// tokenize.go 对照 retrieval/tokenize.ts：
// 中文不能只按空格切分——中文段展开成 2 字滑窗，英文/数字按词，两侧口径一致。

var cjkRange = func(r rune) bool {
	return (r >= 0x3400 && r <= 0x4DBF) || (r >= 0x4E00 && r <= 0x9FFF) || (r >= 0xF900 && r <= 0xFAFF)
}

func isSplitRune(r rune) bool {
	if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
		return true
	}
	if unicode.IsPunct(r) || unicode.IsSymbol(r) {
		return true
	}
	return false
}

// makeNgrams 长度 n 的滑窗。
func makeNgrams(text string, n int) []string {
	runes := []rune(text)
	if n < 1 || len(runes) < n {
		return nil
	}
	grams := make([]string, 0, len(runes)-n+1)
	for i := 0; i+n <= len(runes); i++ {
		grams = append(grams, string(runes[i:i+n]))
	}
	return grams
}

// buildIndexTokens 文档侧词元：英文/数字按词，中文按 2 字滑窗。
func buildIndexTokens(text string) []string {
	normalized := strings.ToLower(strings.TrimSpace(text))
	if normalized == "" {
		return nil
	}
	tokens := make([]string, 0, 32)
	for _, part := range splitTokenParts(normalized) {
		if part == "" {
			continue
		}
		hasCJK := strings.ContainsFunc(part, cjkRange)
		if !hasCJK {
			if len([]rune(part)) >= 2 {
				tokens = append(tokens, part)
			}
			continue
		}
		// 混合串：抽出中文段做 bigram，剩余字母数字按词保留
		var latinBuf strings.Builder
		flushLatin := func() {
			w := latinBuf.String()
			if len([]rune(w)) >= 2 {
				tokens = append(tokens, w)
			}
			latinBuf.Reset()
		}
		var cjkRun []rune
		flushCJK := func() {
			if len(cjkRun) == 0 {
				return
			}
			if len(cjkRun) == 1 {
				tokens = append(tokens, string(cjkRun))
			} else {
				tokens = append(tokens, makeNgrams(string(cjkRun), 2)...)
			}
			cjkRun = cjkRun[:0]
		}
		for _, r := range part {
			if cjkRange(r) {
				flushLatin()
				cjkRun = append(cjkRun, r)
			} else {
				flushCJK()
				latinBuf.WriteRune(r)
			}
		}
		flushCJK()
		flushLatin()
	}
	return tokens
}

func splitTokenParts(s string) []string {
	parts := make([]string, 0, 16)
	current := strings.Builder{}
	for _, r := range s {
		if isSplitRune(r) {
			if current.Len() > 0 {
				parts = append(parts, current.String())
				current.Reset()
			}
			continue
		}
		current.WriteRune(r)
	}
	if current.Len() > 0 {
		parts = append(parts, current.String())
	}
	return parts
}

// buildQueryTokens 查询侧词元：与文档侧同口径，去重。
func buildQueryTokens(query string) []string {
	seen := map[string]bool{}
	tokens := make([]string, 0, 16)
	for _, tok := range buildIndexTokens(query) {
		if seen[tok] {
			continue
		}
		seen[tok] = true
		tokens = append(tokens, tok)
	}
	return tokens
}

// likePatterns 把词元转成 ILIKE 模式数组（%tok%）。
func likePatterns(tokens []string) []string {
	out := make([]string, 0, len(tokens))
	for _, tok := range tokens {
		if trimSpace(tok) == "" {
			continue
		}
		out = append(out, "%"+sanitizeLike(tok)+"%")
	}
	return out
}
