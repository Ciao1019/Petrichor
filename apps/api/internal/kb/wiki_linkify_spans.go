package kb

import (
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

func wikiHasASCIIWordEdge(value string) bool {
	if value == "" {
		return false
	}
	first, _ := utf8.DecodeRuneInString(value)
	last, _ := utf8.DecodeLastRuneInString(value)
	return wikiASCIIWordRune(first) || wikiASCIIWordRune(last)
}

func wikiASCIIWordRune(r rune) bool {
	return r <= unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_')
}

func wikiSpanOverlaps(spans []wikiForbiddenSpan, start, end int) bool {
	for _, span := range spans {
		if start < span.end && end > span.start {
			return true
		}
	}
	return false
}

func shiftWikiSpansAfter(spans []wikiForbiddenSpan, pivot, delta int) []wikiForbiddenSpan {
	if delta == 0 {
		return spans
	}
	out := make([]wikiForbiddenSpan, len(spans))
	for index, span := range spans {
		if span.start >= pivot {
			span.start += delta
			span.end += delta
		}
		out[index] = span
	}
	return out
}

// computeWikiForbiddenSpans 保护代码、已有 Wiki 链接、Markdown 链接/图片、引用定义和自动链接。
func computeWikiForbiddenSpans(content string) ([]wikiForbiddenSpan, map[string]struct{}) {
	spans := scanWikiReferenceDefinitions(content)
	used := map[string]struct{}{}
	for index := 0; index < len(content); {
		if wikiFenceStart(content, index) {
			run, marker := wikiFenceRun(content, index)
			end := wikiFenceEnd(content, index+run, marker, run)
			spans = append(spans, wikiForbiddenSpan{start: index, end: end})
			index = end
			continue
		}
		switch content[index] {
		case '`':
			run := 1
			for index+run < len(content) && content[index+run] == '`' {
				run++
			}
			closeIndex := wikiInlineCodeClose(content, index+run, run)
			if closeIndex < 0 {
				index += run
				continue
			}
			end := closeIndex + run
			spans = append(spans, wikiForbiddenSpan{start: index, end: end})
			index = end
		case '[':
			if index+1 < len(content) && content[index+1] == '[' {
				if relativeClose := strings.Index(content[index+2:], "]]"); relativeClose >= 0 {
					end := index + 2 + relativeClose + 2
					inner := content[index+2 : index+2+relativeClose]
					if pipe := strings.IndexByte(inner, '|'); pipe >= 0 {
						inner = inner[:pipe]
					}
					if slug := strings.TrimSpace(inner); slug != "" {
						used[slug] = struct{}{}
					}
					spans = append(spans, wikiForbiddenSpan{start: index, end: end})
					index = end
					continue
				}
			}
			if end, ok := matchWikiMarkdownLink(content, index); ok {
				spans = append(spans, wikiForbiddenSpan{start: index, end: end})
				index = end
				continue
			}
			if end, ok := matchWikiReferenceLink(content, index); ok {
				spans = append(spans, wikiForbiddenSpan{start: index, end: end})
				index = end
				continue
			}
			index++
		case '!':
			if index+1 < len(content) && content[index+1] == '[' {
				if end, ok := matchWikiMarkdownLink(content, index+1); ok {
					spans = append(spans, wikiForbiddenSpan{start: index, end: end})
					index = end
					continue
				}
				if end, ok := matchWikiReferenceLink(content, index+1); ok {
					spans = append(spans, wikiForbiddenSpan{start: index, end: end})
					index = end
					continue
				}
			}
			index++
		case '<':
			if end, ok := matchWikiAutolink(content, index); ok {
				spans = append(spans, wikiForbiddenSpan{start: index, end: end})
				index = end
				continue
			}
			index++
		default:
			index++
		}
	}
	sort.Slice(spans, func(i, j int) bool {
		if spans[i].start != spans[j].start {
			return spans[i].start < spans[j].start
		}
		return spans[i].end < spans[j].end
	})
	return spans, used
}

func wikiClosingBracket(content string, start int) (int, bool) {
	if start >= len(content) || content[start] != '[' {
		return 0, false
	}
	depth := 1
	for index := start + 1; index < len(content); index++ {
		switch content[index] {
		case '\\':
			index++
		case '[':
			depth++
		case ']':
			depth--
			if depth == 0 {
				return index, true
			}
		case '\n':
			return 0, false
		}
	}
	return 0, false
}

func matchWikiReferenceLink(content string, start int) (int, bool) {
	textEnd, ok := wikiClosingBracket(content, start)
	if !ok || textEnd+1 >= len(content) || content[textEnd+1] != '[' {
		return 0, false
	}
	labelEnd, ok := wikiClosingBracket(content, textEnd+1)
	return labelEnd + 1, ok
}

func matchWikiMarkdownLink(content string, start int) (int, bool) {
	textEnd, ok := wikiClosingBracket(content, start)
	if !ok || textEnd+1 >= len(content) || content[textEnd+1] != '(' {
		return 0, false
	}
	depth := 1
	for index := textEnd + 2; index < len(content); index++ {
		switch content[index] {
		case '\\':
			index++
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return index + 1, true
			}
		case '\n':
			return 0, false
		}
	}
	return 0, false
}

func scanWikiReferenceDefinitions(content string) []wikiForbiddenSpan {
	spans := []wikiForbiddenSpan{}
	for lineStart := 0; lineStart < len(content); {
		relativeEnd := strings.IndexByte(content[lineStart:], '\n')
		lineEnd := len(content)
		if relativeEnd >= 0 {
			lineEnd = lineStart + relativeEnd + 1
		}
		indent := 0
		for indent < 3 && lineStart+indent < lineEnd && content[lineStart+indent] == ' ' {
			indent++
		}
		start := lineStart + indent
		if start < lineEnd && content[start] == '[' {
			if labelEnd, ok := wikiClosingBracket(content, start); ok && labelEnd+1 < lineEnd && content[labelEnd+1] == ':' {
				spans = append(spans, wikiForbiddenSpan{start: lineStart, end: lineEnd})
			}
		}
		lineStart = lineEnd
	}
	return spans
}

func wikiFenceStart(content string, index int) bool {
	if index > 0 && content[index-1] != '\n' {
		return false
	}
	if index+2 >= len(content) || (content[index] != '`' && content[index] != '~') {
		return false
	}
	return content[index+1] == content[index] && content[index+2] == content[index]
}

func wikiFenceRun(content string, index int) (int, byte) {
	marker := content[index]
	end := index
	for end < len(content) && content[end] == marker {
		end++
	}
	return end - index, marker
}

func wikiFenceEnd(content string, start int, marker byte, minimumRun int) int {
	newline := strings.IndexByte(content[start:], '\n')
	if newline < 0 {
		return len(content)
	}
	for position := start + newline + 1; position < len(content); {
		if content[position] == marker {
			run, _ := wikiFenceRun(content, position)
			if run >= minimumRun {
				if lineEnd := strings.IndexByte(content[position:], '\n'); lineEnd >= 0 {
					return position + lineEnd + 1
				}
				return len(content)
			}
		}
		newline = strings.IndexByte(content[position:], '\n')
		if newline < 0 {
			return len(content)
		}
		position += newline + 1
	}
	return len(content)
}

func wikiInlineCodeClose(content string, start, runLength int) int {
	for index := start; index < len(content); {
		if index+1 < len(content) && content[index] == '\n' && content[index+1] == '\n' {
			return -1
		}
		if content[index] != '`' {
			index++
			continue
		}
		end := index
		for end < len(content) && content[end] == '`' {
			end++
		}
		if end-index == runLength {
			return index
		}
		index = end
	}
	return -1
}

func matchWikiAutolink(content string, start int) (int, bool) {
	if start >= len(content) || content[start] != '<' {
		return 0, false
	}
	closeIndex := strings.IndexByte(content[start+1:], '>')
	if closeIndex < 0 {
		return 0, false
	}
	inner := content[start+1 : start+1+closeIndex]
	if inner == "" || strings.ContainsAny(inner, " \t\n") || (!strings.Contains(inner, "://") && !strings.HasPrefix(inner, "mailto:")) {
		return 0, false
	}
	return start + closeIndex + 2, true
}
