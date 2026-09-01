// kb-workflow.go 对照 knowledge-build-workflow.ts：确定性 Markdown 切片 +
// LLM 步骤（问题生成 / 候选抽取 / 目录规划 / 页面物化），全部走 ChatInvoker 注入。
package kb

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
)

const (
	knowledgeChunkMaxChars     = 3200
	knowledgeChunkTargetChars  = 1200
	knowledgeChunkMinTailChars = 400
	knowledgeShortHeadingChars = 120
	headingDominanceRatio      = 0.6
	knowledgeChunkOverlapChars = 320
	knowledgeChunkLimit        = 120
	questionBatchMaxChars      = 4000
	questionBatchMaxItems      = 4
	wikiDocumentMaxChars       = 72000
	wikiItemLimit              = 24
	wikiPageBatchSize          = 4
)

var (
	wfHeadingPattern = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*#*\s*$`)
	wfFencePattern   = regexp.MustCompile(`^\s*(` + "`" + `{3}|~{3})`)
)

// mdSection 结构解析输出。
type mdSection struct {
	headingPath []string
	heading     string
	text        string
}

func topLevelOf(s mdSection) string {
	if len(s.headingPath) > 0 {
		return s.headingPath[0]
	}
	return "\x00导语"
}

func groupLength(g []mdSection) int {
	total := 0
	for _, s := range g {
		total += len(s.text)
	}
	return total
}

func isShortHeadingOnly(s mdSection) bool { return len([]rune(s.text)) <= knowledgeShortHeadingChars }

// parseMarkdownSections 阶段①：h1–h6 全部是候选边界，围栏内 # 不算标题。
func parseMarkdownSections(markdown string, articleTitle string) []mdSection {
	normalized := strings.TrimSpace(regexp.MustCompile(`\r\n?`).ReplaceAllString(markdown, "\n"))
	if normalized == "" {
		return nil
	}
	var sections []mdSection
	type stackEntry struct {
		level int
		title string
	}
	stack := []stackEntry{}
	buffer := []string{}
	inFence := false
	flush := func() {
		text := strings.Join(buffer, "\n")
		text = trimSpace(text)
		buffer = buffer[:0]
		if text == "" {
			return
		}
		heading := articleTitle
		if trimSpace(heading) == "" {
			heading = "文档正文"
		}
		path := make([]string, 0, len(stack))
		for _, item := range stack {
			path = append(path, item.title)
		}
		if len(stack) > 0 {
			heading = stack[len(stack)-1].title
		}
		sections = append(sections, mdSection{headingPath: path, heading: heading, text: text})
	}
	for _, line := range strings.Split(normalized, "\n") {
		if wfFencePattern.MatchString(line) {
			inFence = !inFence
			buffer = append(buffer, line)
			continue
		}
		match := wfHeadingPattern.FindStringSubmatch(line)
		if match != nil && !inFence {
			flush()
			level := len(match[1])
			title := trimSpace(match[2])
			if title == "" {
				title = articleTitle
			}
			for len(stack) > 0 && stack[len(stack)-1].level >= level {
				stack = stack[:len(stack)-1]
			}
			stack = append(stack, stackEntry{level, title})
		}
		buffer = append(buffer, line)
	}
	flush()
	return sections
}

// resolveMergedHeading 合并后的身份归属：占绝对多数（≥60% 字符）段落定名，否则锚到首个实质段。
func resolveMergedHeading(group []mdSection, articleTitle string) (string, []string) {
	fallbackTitle := articleTitle
	if trimSpace(fallbackTitle) == "" {
		fallbackTitle = "文档正文"
	}
	if len(group) == 1 {
		return group[0].heading, group[0].headingPath
	}
	total := groupLength(group)
	var anchor *mdSection
	for i := range group {
		if float64(len(group[i].text)) >= float64(total)*headingDominanceRatio {
			anchor = &group[i]
			break
		}
	}
	if anchor == nil {
		for i := range group {
			if !isShortHeadingOnly(group[i]) {
				anchor = &group[i]
				break
			}
		}
	}
	if anchor == nil {
		anchor = &group[0]
	}
	if len(anchor.headingPath) > 0 {
		return anchor.headingPath[len(anchor.headingPath)-1], anchor.headingPath
	}
	return fallbackTitle, anchor.headingPath
}

// mergeSections 阶段②：贪心合并 + 小组兜底，均不跨顶层主题、不超硬上限。
func mergeSections(sections []mdSection, articleTitle string) []struct {
	heading     string
	headingPath []string
	text        string
} {
	groups := [][]mdSection{}
	current := []mdSection{}
	currentLength := 0
	for _, section := range sections {
		if len(current) == 0 {
			current = []mdSection{section}
			currentLength = len(section.text)
			continue
		}
		sameTop := topLevelOf(section) == topLevelOf(current[0])
		onlyShortHeading := true
		for _, s := range current {
			if !isShortHeadingOnly(s) {
				onlyShortHeading = false
				break
			}
		}
		projected := currentLength + len(section.text) + 1
		mayOverflow := currentLength < knowledgeChunkMinTailChars && projected <= knowledgeChunkMaxChars
		if !sameTop || (!onlyShortHeading && !mayOverflow && projected > knowledgeChunkTargetChars) {
			groups = append(groups, current)
			current = []mdSection{section}
			currentLength = len(section.text)
			continue
		}
		current = append(current, section)
		currentLength = projected
	}
	if len(current) > 0 {
		groups = append(groups, current)
	}

	// 小组兜底：不足 MIN 的组优先并入同主题邻组（后 → 前）。
	for index := len(groups) - 1; index >= 0; index-- {
		if groupLength(groups[index]) >= knowledgeChunkMinTailChars {
			continue
		}
		length := groupLength(groups[index])
		canMergeNext := false
		canMergePrev := false
		if index+1 < len(groups) && topLevelOf(groups[index+1][0]) == topLevelOf(groups[index][0]) &&
			length+groupLength(groups[index+1]) <= knowledgeChunkMaxChars {
			canMergeNext = true
		} else if index-1 >= 0 && topLevelOf(groups[index-1][0]) == topLevelOf(groups[index][0]) &&
			length+groupLength(groups[index-1]) <= knowledgeChunkMaxChars {
			canMergePrev = true
		}
		if canMergeNext {
			groups[index] = append(groups[index], groups[index+1]...)
			groups = append(groups[:index+1], groups[index+2:]...)
		} else if canMergePrev {
			merged := append(append([]mdSection{}, groups[index-1]...), groups[index]...)
			groups[index-1] = merged
			groups = append(groups[:index], groups[index+1:]...)
		}
	}

	out := make([]struct {
		heading     string
		headingPath []string
		text        string
	}, 0, len(groups))
	for _, group := range groups {
		heading, path := resolveMergedHeading(group, articleTitle)
		parts := make([]string, 0, len(group))
		for _, s := range group {
			parts = append(parts, s.text)
		}
		out = append(out, struct {
			heading     string
			headingPath []string
			text        string
		}{heading: heading, headingPath: path, text: strings.Join(parts, "\n\n")})
	}
	return out
}

// fenceSpan 围栏区间 [start, end)，断点不得落在其中。
type fenceSpan struct{ start, end int }

func collectFenceSpans(text string) []fenceSpan {
	spans := []fenceSpan{}
	offset := 0
	openAt := -1
	for _, line := range strings.Split(text, "\n") {
		if wfFencePattern.MatchString(line) {
			if openAt < 0 {
				openAt = offset
			} else {
				spans = append(spans, fenceSpan{openAt, offset + len(line)})
				openAt = -1
			}
		}
		offset += len(line) + 1
	}
	if openAt >= 0 {
		spans = append(spans, fenceSpan{openAt, len(text)})
	}
	return spans
}

func fenceSpanAt(spans []fenceSpan, index int) *fenceSpan {
	for i := range spans {
		if index > spans[i].start && index < spans[i].end {
			return &spans[i]
		}
	}
	return nil
}

var sentenceEndRe = regexp.MustCompile("[。！？；!?;]")

// findBreakPoint 在 [from, to) 内找不落在围栏中的分隔点；优先级 \n\n > \n > 句终符。
func findBreakPoint(text string, from, to int, spans []fenceSpan) int {
	candidates := []int{}
	if p := strings.LastIndex(text[:to], "\n\n"); p > from {
		candidates = append(candidates, p)
	}
	if l := strings.LastIndex(text[:to], "\n"); l > from {
		candidates = append(candidates, l)
	}
	sentence := -1
	for _, loc := range sentenceEndRe.FindAllStringIndex(text[from:to], -1) {
		sentence = from + loc[0] + loc[1]
	}
	if sentence > from {
		candidates = append(candidates, sentence)
	}
	for _, candidate := range candidates {
		if fenceSpanAt(spans, candidate) == nil {
			return candidate
		}
	}
	return -1
}

// splitLongSection 阶段③：超长回退切分。
func splitLongSection(text string, maxChars, overlapChars int) []string {
	runes := []rune(text)
	if len(runes) <= maxChars {
		return []string{text}
	}
	byteText := text
	spans := collectFenceSpans(byteText)
	chunks := []string{}
	cursor := 0 // rune 下标
	byteAt := func(runes_ []rune, i int) int { return len(string(runes_[:i])) }
	for cursor < len(runes) {
		hardEndRune := cursor + maxChars
		endRune := hardEndRune
		if hardEndRune < len(runes) {
			hardEndByte := byteAt(runes, hardEndRune)
			floorRune := cursor + maxChars*55/100
			floor := byteAt(runes, floorRune)
			if candidate := findBreakPoint(byteText, floor, hardEndByte, spans); candidate >= 0 {
				endRune = runeIndexFromByte(runes, candidate)
			} else if span := fenceSpanAt(spans, hardEndByte); span != nil {
				endRune = runeIndexFromByte(runes, span.end)
			}
		}
		end := byteAt(runes, endRune)
		value := trimSpace(byteText[byteAt(runes, cursor):end])
		if value != "" {
			chunks = append(chunks, value)
		}
		if endRune >= len(runes) {
			break
		}
		nextRune := endRune - overlapChars
		if nextRune <= cursor {
			nextRune = cursor + 1
		}
		if span := fenceSpanAt(spans, byteAt(runes, nextRune)); span != nil {
			nextRune = runeIndexFromByte(runes, span.end)
			if nextRune <= cursor {
				nextRune = cursor + 1
			}
		}
		aligned := strings.Index(byteText[byteAt(runes, nextRune):end], "\n")
		if aligned >= 0 {
			nextRune = runeIndexFromByte(runes, byteAt(runes, nextRune)+aligned+1)
		}
		if nextRune <= cursor {
			nextRune = cursor + 1
		}
		cursor = nextRune
	}
	return chunks
}

func runeIndexFromByte(runes []rune, byteOffset int) int {
	count := 0
	size := 0
	for count < len(runes) {
		size += len(string(runes[count]))
		if size > byteOffset {
			break
		}
		count++
	}
	return count
}

type wfChunk struct {
	chunkKey             string
	position             int32
	heading              string
	headingPath          []string
	contentMd            string
	contentHash          string
	recommendedQuestions []string
}

// splitMarkdownForKnowledgeBuild 结构切片主入口。
func splitMarkdownForKnowledgeBuild(markdown string, articleTitle string, maxChars int) ([]wfChunk, bool) {
	if maxChars <= 0 {
		maxChars = knowledgeChunkMaxChars
	}
	sections := parseMarkdownSections(markdown, articleTitle)
	if len(sections) == 0 {
		return nil, false
	}
	chunks := []wfChunk{}
	truncated := false
	for _, merged := range mergeSections(sections, articleTitle) {
		for _, piece := range splitLongSection(merged.text, maxChars, knowledgeChunkOverlapChars) {
			if len(chunks) >= knowledgeChunkLimit {
				truncated = true
				return chunks, truncated
			}
			position := int32(len(chunks))
			key := "chunk-" + padLeft(strconvItoa(int(position)+1), 3, '0')
			chunks = append(chunks, wfChunk{
				chunkKey:    key,
				position:    position,
				heading:     merged.heading,
				headingPath: merged.headingPath,
				contentMd:   piece,
				contentHash: fnvHash8(piece),
			})
		}
	}
	return chunks, truncated
}

func strconvItoa(n int) string { return jsonNumber(n) }

func jsonNumber(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func padLeft(s string, n int, pad byte) string {
	for len(s) < n {
		s = string(pad) + s
	}
	return s
}

// ===== LLM 步骤 =====

// extractJSONObjects 对应 extractJsonObject：截取首尾大括号间内容并解析。
func extractJSONObjects(raw string) map[string]any {
	start := strings.Index(raw, "{")
	end := strings.LastIndex(raw, "}")
	if start < 0 || end < start {
		return nil
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(raw[start:end+1]), &value); err != nil {
		return nil
	}
	return value
}

// normalizeRecommendedQuestions 补足到恰好 3 个模板问题。
func normalizeRecommendedQuestions(values any, heading string) []string {
	normalized := normalizeStringList(values, 3)
	fallbacks := []string{
		heading + " 主要讲了什么？",
		heading + " 中有哪些关键结论？",
		"如何理解并应用 " + heading + "？",
	}
	for _, fallback := range fallbacks {
		if len(normalized) >= 3 {
			break
		}
		exists := false
		for _, q := range normalized {
			if q == fallback {
				exists = true
				break
			}
		}
		if !exists {
			normalized = append(normalized, fallback)
		}
	}
	if len(normalized) > 3 {
		normalized = normalized[:3]
	}
	return normalized
}

func renderHeadingTrail(chunk wfChunk) string {
	if len(chunk.headingPath) > 0 {
		return strings.Join(chunk.headingPath, " > ")
	}
	return chunk.heading
}

// batchChunksByBudget 按字符预算分批，单片超预算自成一批。
func batchChunksByBudget(chunks []wfChunk, maxChars, maxItems int) [][]wfChunk {
	batches := [][]wfChunk{}
	current := []wfChunk{}
	currentChars := 0
	for _, chunk := range chunks {
		size := len([]rune(chunk.contentMd))
		if len(current) > 0 && (len(current) >= maxItems || currentChars+size > maxChars) {
			batches = append(batches, current)
			current = nil
			currentChars = 0
		}
		current = append(current, chunk)
		currentChars += size
	}
	if len(current) > 0 {
		batches = append(batches, current)
	}
	return batches
}

func mapWithConcurrency[T any, R any](values []T, concurrency int, mapper func(T) R) []R {
	results := make([]R, len(values))
	if len(values) == 0 {
		return results
	}
	if concurrency < 1 {
		concurrency = 1
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)
	cursor := int64(-1)
	var mu sync.Mutex
	for worker := 0; worker < concurrency; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				cursor++
				index := cursor
				mu.Unlock()
				if index >= int64(len(values)) {
					return
				}
				sem <- struct{}{}
				results[index] = mapper(values[index])
				<-sem
			}
		}()
	}
	wg.Wait()
	return results
}

// generateChunkQuestions 为每个切片生成 3 个推荐问题；LLM 失败回落模板问题。
func generateChunkQuestions(ctx context.Context, userID int64, profile compileProfile, articleTitle string, chunks []wfChunk) ([]chunkWithQuestions, []string) {
	type batchResult struct {
		chunks   []chunkWithQuestions
		warnings []string
	}
	batches := batchChunksByBudget(chunks, questionBatchMaxChars, questionBatchMaxItems)
	outputs := mapWithConcurrency(batches, questionBatchConcurrency, func(batch []wfChunk) batchResult {
		fallback := make([]chunkWithQuestions, 0, len(batch))
		for _, chunk := range batch {
			fallback = append(fallback, chunkWithQuestions{chunk: chunk,
				recommendedQuestions: normalizeRecommendedQuestions(nil, chunk.heading)})
		}
		messageParts := make([]string, 0, len(batch))
		for _, chunk := range batch {
			messageParts = append(messageParts,
				"<chunk id=\""+chunk.chunkKey+"\" heading=\""+renderHeadingTrail(chunk)+"\">\n"+
					chunk.contentMd+"\n</chunk>")
		}
		answer, err := invokeKnowledgeBuildChat(ctx, ChatRequest{
			UserID: userID,
			SystemPrompt: profile.systemPrompt(
				"你是知识库问题生成器。为每个 Markdown 切片生成恰好 3 个用户可能提出的推荐问题。",
				"heading 是该切片在文档中的完整标题路径（用 > 分隔），可据此判断切片所处的语境层级。",
				"问题必须能仅依据对应切片回答，具体、互不重复，不要输出答案。",
				"只输出 JSON：{\"questions\":{\"chunk-001\":[\"问题1\",\"问题2\",\"问题3\"]}}。",
			),
			Message: strings.Join(messageParts, "\n\n"),
			Op:      "kb.build.questions",
		})
		if err != nil {
			return batchResult{chunks: fallback, warnings: []string{"推荐问题生成失败：" + err.Error()}}
		}
		parsed := extractJSONObjects(answer)
		if parsed == nil {
			return batchResult{chunks: fallback}
		}
		questionsMap, ok := parsed["questions"].(map[string]any)
		if !ok {
			return batchResult{chunks: fallback}
		}
		out := make([]chunkWithQuestions, 0, len(batch))
		missing := 0
		for _, chunk := range batch {
			if questionsMap[chunk.chunkKey] == nil {
				missing++
			}
			out = append(out, chunkWithQuestions{chunk: chunk,
				recommendedQuestions: normalizeRecommendedQuestions(questionsMap[chunk.chunkKey], chunk.heading)})
		}
		result := batchResult{chunks: out}
		if missing > 0 {
			result.warnings = []string{jsonInt(missing) + " 个切片未拿到模型问题，已使用模板问题"}
		}
		return result
	})
	flat := []chunkWithQuestions{}
	warnings := []string{}
	for _, batchOut := range outputs {
		flat = append(flat, batchOut.chunks...)
		warnings = append(warnings, batchOut.warnings...)
	}
	uniqueWarnings := dedupeStrings(warnings)
	if len(uniqueWarnings) > 5 {
		uniqueWarnings = uniqueWarnings[:5]
	}
	return flat, uniqueWarnings
}

func jsonInt(n int) string { return jsonNumber(n) }

func dedupeStrings(in []string) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, v := range in {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}
