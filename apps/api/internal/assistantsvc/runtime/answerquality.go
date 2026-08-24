package runtime

import (
	"regexp"
	"strings"
)

// ===== 回答质量（对照 answer-quality.ts）=====

// AnswerDepth 回答详略度。
type AnswerDepth string

const (
	DepthBrief    AnswerDepth = "brief"
	DepthStandard AnswerDepth = "standard"
	DepthDetailed AnswerDepth = "detailed"
)

var (
	briefRequestPattern    = regexp.MustCompile(`(?i)(一句话|一两句|简短|简要|简单说|概括|只说结论|不要展开|tl\s*;?\s*dr)`)
	detailedRequestPattern = regexp.MustCompile(`(详细|详尽|全面|深入|展开|系统(地|性)?|逐项|完整介绍|具体说明|多讲|细说)`)
	conceptQuestionPattern = regexp.MustCompile(`(是什么|什么是|介绍(?:一下)?|是做什么的|有何作用|用途是什么|能做什么)`)
)

// ResolveAnswerDepth 解析详略度。
func ResolveAnswerDepth(goal string) AnswerDepth {
	if briefRequestPattern.MatchString(goal) {
		return DepthBrief
	}
	if detailedRequestPattern.MatchString(goal) {
		return DepthDetailed
	}
	return DepthStandard
}

// BuildAnswerQualityGuidance 注入主 Agent 与强制收敛阶段的统一质量要求。
func BuildAnswerQualityGuidance(goal string) string {
	depth := ResolveAnswerDepth(goal)
	if depth == DepthBrief {
		return joinStrings([]string{
			"用户明确希望简短回答：先给结论，用 1～3 句话覆盖最关键的信息。",
			"不要为了凑长度展开；但仍需标注实际使用的证据。",
		}, "\n")
	}

	common := []string{
		"默认目标是完整、可用，而不是越短越好；不要只把多条证据压成一句定义。",
		"先直接给结论，再解释关键事实；证据覆盖不到的内容不要为了凑长度而编造。",
		"除非用户明确要求一句话，否则有充足证据时至少从多个信息点展开，并使用短段落或项目符号提高可读性。",
	}

	if depth == DepthDetailed {
		return joinStrings(append(common,
			"用户希望详细说明：尽量覆盖背景/定位、核心能力或机制、典型使用方式、优势与限制、适用对象或注意事项。",
			"信息较多时使用小标题组织；每个结论都应能在证据中找到依据。"), "\n")
	}

	if conceptQuestionPattern.MatchString(goal) {
		return joinStrings(append(common,
			"这是概念/产品介绍类问题：在证据允许时，覆盖“它是什么、核心能力、怎么使用或适合谁、限制/注意事项”四类信息，而不只复述名称和一句定位。"), "\n")
	}

	return joinStrings(append(common,
		"在证据允许时，至少覆盖结论、依据/原因、实际影响或下一步建议。"), "\n")
}

// AnswerQualityResult 质量门结果。
type AnswerQualityResult struct {
	Adequate      bool
	Depth         AnswerDepth
	AnswerChars   int
	ContentUnits  int
	EvidenceChars int
	Reasons       []string
}

// AssessAnswerQuality 轻量质量门：只在已有较丰富 Evidence 时拦截明显草率的答案。
func AssessAnswerQuality(goal, answer string, evidence []AgentEvidence) AnswerQualityResult {
	depth := ResolveAnswerDepth(goal)
	answerChars := VisibleCharacterCount(answer)
	contentUnits := CountContentUnits(answer)
	evidenceChars := 0
	for _, item := range evidence {
		evidenceChars += len([]rune(trimSpace(item.Content)))
	}
	reasons := []string{}

	if depth == DepthBrief || len(evidence) == 0 || evidenceChars < 240 {
		return AnswerQualityResult{
			Adequate: answerChars > 0, Depth: depth, AnswerChars: answerChars,
			ContentUnits: contentUnits, EvidenceChars: evidenceChars,
			Reasons: boolSlice(answerChars > 0, nil, []string{"回答为空"}),
		}
	}

	isConcept := conceptQuestionPattern.MatchString(goal)
	var minChars int
	switch {
	case depth == DepthDetailed:
		minChars = clampInt(roundInt(float64(evidenceChars)*0.14), 280, 520)
	case isConcept:
		minChars = clampInt(roundInt(float64(evidenceChars)*0.1), 180, 320)
	default:
		minChars = clampInt(roundInt(float64(evidenceChars)*0.08), 140, 260)
	}
	minUnits := map[bool]int{true: 4, false: 2}[depth == DepthDetailed]
	if isConcept && depth != DepthDetailed {
		minUnits = 3
	}

	if answerChars < minChars {
		reasons = append(reasons, "正文仅 "+itoa(answerChars)+" 字，低于当前证据量对应的完整回答下限 "+itoa(minChars)+" 字")
	}
	if contentUnits < minUnits {
		reasons = append(reasons, "只覆盖 "+itoa(contentUnits)+" 个信息点，至少应覆盖 "+itoa(minUnits)+" 个")
	}

	return AnswerQualityResult{
		Adequate: len(reasons) == 0, Depth: depth, AnswerChars: answerChars,
		ContentUnits: contentUnits, EvidenceChars: evidenceChars, Reasons: reasons,
	}
}

var (
	codeBlockPattern     = regexp.MustCompile("(?s)```.*?```")
	urlPattern           = regexp.MustCompile(`https?://\S+`)
	citationPattern      = regexp.MustCompile(`\[\d+\]`)
	markdownNoisePattern = regexp.MustCompile(`[#>*_` + "`" + `~|-]`)
	sentencePattern      = regexp.MustCompile(`[^。！？!?\n]+[。！？!?]?`)
	listPrefixPattern    = regexp.MustCompile(`^\s*(?:[-*+] |\d+[.)、]\s*|#+\s*)`)
	unitSplitPattern     = regexp.MustCompile(`(?:\r?\n)+|[。！？!?；;]+`)
	multiNewlinePattern  = regexp.MustCompile(`\n{3,}`)
)

// DedupeRepeatedAnswer 删除流式重启或模型重试造成的完全重复句/行。
func DedupeRepeatedAnswer(answer string) string {
	lines := strings.Split(answer, "\n")
	seenLines := map[string]bool{}
	dedupedLines := make([]string, 0, len(lines))
	for _, line := range lines {
		key := normalizeRepeatUnit(line)
		if len([]rune(key)) < 12 {
			dedupedLines = append(dedupedLines, line)
			continue
		}
		if seenLines[key] {
			continue
		}
		seenLines[key] = true
		dedupedLines = append(dedupedLines, line)
	}

	text := strings.Join(dedupedLines, "\n")
	seenSentences := map[string]bool{}
	text = sentencePattern.ReplaceAllStringFunc(text, func(sentence string) string {
		key := normalizeRepeatUnit(sentence)
		if len([]rune(key)) < 16 {
			return sentence
		}
		if seenSentences[key] {
			return ""
		}
		seenSentences[key] = true
		return sentence
	})
	text = multiNewlinePattern.ReplaceAllString(text, "\n\n")
	return trimSpace(text)
}

func normalizeRepeatUnit(value string) string {
	value = listPrefixPattern.ReplaceAllString(value, "")
	value = whitespacePattern.ReplaceAllString(value, "")
	return trimSpace(value)
}

// VisibleCharacterCount 可见字符数。
func VisibleCharacterCount(text string) int {
	t := codeBlockPattern.ReplaceAllString(text, "")
	t = urlPattern.ReplaceAllString(t, "")
	t = citationPattern.ReplaceAllString(t, "")
	t = markdownNoisePattern.ReplaceAllString(t, "")
	t = whitespacePattern.ReplaceAllString(t, "")
	return len([]rune(t))
}

// CountContentUnits 内容点计数。
func CountContentUnits(text string) int {
	count := 0
	for _, item := range unitSplitPattern.Split(text, -1) {
		item = trimSpace(listPrefixPattern.ReplaceAllString(item, ""))
		if VisibleCharacterCount(item) >= 8 {
			count++
		}
	}
	return count
}

func clampInt(v, minV, maxV int) int {
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

func roundInt(v float64) int {
	if v < 0 {
		return -int(-v + 0.5)
	}
	return int(v + 0.5)
}

func boolSlice(cond bool, a, b []string) []string {
	if cond {
		return a
	}
	return b
}
