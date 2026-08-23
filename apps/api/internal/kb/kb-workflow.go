// kb-workflow.go 对照 knowledge-build-workflow.ts：确定性 Markdown 切片 +
// LLM 步骤（问题生成 / 候选抽取 / 目录规划 / 页面物化），全部走 ChatInvoker 注入。
package kb

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
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
	questionBatchConcurrency   = 3
	wikiDocumentMaxChars       = 72000
	wikiItemLimit              = 24
	wikiPageBatchSize          = 4
	wikiPageBatchConcurrency   = 3
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
func generateChunkQuestions(ctx context.Context, userID int64, knowledgeBaseName, articleTitle string, chunks []wfChunk) ([]chunkWithQuestions, []string) {
	warnings := []string{}
	batches := batchChunksByBudget(chunks, questionBatchMaxChars, questionBatchMaxItems)
	outputs := mapWithConcurrency(batches, questionBatchConcurrency, func(batch []wfChunk) []chunkWithQuestions {
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
		answer, err := ChatInvoker(ctx, ChatRequest{
			UserID: userID,
			SystemPrompt: strings.Join([]string{
				"你是知识库问题生成器。为每个 Markdown 切片生成恰好 3 个用户可能提出的推荐问题。",
				"heading 是该切片在文档中的完整标题路径（用 > 分隔），可据此判断切片所处的语境层级。",
				"问题必须能仅依据对应切片回答，具体、互不重复，不要输出答案。",
				"只输出 JSON：{\"questions\":{\"chunk-001\":[\"问题1\",\"问题2\",\"问题3\"]}}。",
			}, "\n"),
			Message: strings.Join(messageParts, "\n\n"),
			Op:      "kb.build.questions",
		})
		if err != nil {
			warnings = append(warnings, "推荐问题生成失败："+err.Error())
			return fallback
		}
		parsed := extractJSONObjects(answer)
		if parsed == nil {
			return fallback
		}
		questionsMap, ok := parsed["questions"].(map[string]any)
		if !ok {
			return fallback
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
		if missing > 0 {
			warnings = append(warnings, jsonInt(missing)+" 个切片未拿到模型问题，已使用模板问题")
		}
		return out
	})
	flat := []chunkWithQuestions{}
	for _, batchOut := range outputs {
		flat = append(flat, batchOut...)
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

type chunkWithQuestions struct {
	chunk                wfChunk
	recommendedQuestions []string
}

// knowledgeCandidate 候选骨架。
type knowledgeCandidate struct {
	kind         string // entity | concept
	name         string
	pageKey      string
	aliases      []string
	summary      string
	categoryPath []string
}

// knowledgeRelation 关系。
type knowledgeRelation struct {
	fromPageKey  string
	toPageKey    string
	relationType string
	description  string
}

// normalizePageKeyForKind 对应 workflow 的 normalizePageKey(raw, kind, name)。
func normalizePageKeyForKind(raw string, kind, name string) string {
	base := trimSpace(raw)
	if base == "" {
		base = kind + "-" + name
	}
	withoutPrefix := regexp.MustCompile(`^(entity|concept)[/\-:]+`).ReplaceAllString(base, "")
	lowered := strings.ToLower(withoutPrefix)
	repl := strings.NewReplacer(" ", "-", "/", "-", "\\", "-", "#", "-", "?", "-", "&", "-", "=", "-")
	lowered = repl.Replace(lowered)
	var b strings.Builder
	lastDash := false
	for _, r := range lowered {
		keep := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			(r >= 0x4e00 && r <= 0x9fa5) || r == '.' || r == '_' || r == '-'
		if !keep {
			continue
		}
		if r == '-' {
			if lastDash {
				continue
			}
			lastDash = true
		} else {
			lastDash = false
		}
		b.WriteRune(r)
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		slug = fnvHash8(name)[:12]
	}
	return kind + "-" + slug
}

func inferPageKind(value string) string {
	if regexp.MustCompile(`(?i)^concept[/\-:]`).MatchString(trimSpace(value)) {
		return "concept"
	}
	return "entity"
}

func localDocumentSummary(contentMd string) string {
	plain := fenceRe.ReplaceAllString(contentMd, " ")
	tagRe := regexp.MustCompile(`<[^>]+>`)
	plain = tagRe.ReplaceAllString(plain, " ")
	plain = mdImageRe.ReplaceAllString(plain, " ")
	linkTextRe := regexp.MustCompile(`\[([^\]]+)]\([^)]*\)`)
	plain = linkTextRe.ReplaceAllString(plain, "$1")
	symbolRe := regexp.MustCompile(`[-#>*_\x60~|]`)
	plain = symbolRe.ReplaceAllString(plain, " ")
	plain = trimSpace(spaceRe.ReplaceAllString(plain, " "))
	runes := []rune(plain)
	if len(runes) <= 260 {
		return plain
	}
	return trimRightSpace(string(runes[:260])) + "…"
}

func trimRightSpace(s string) string { return strings.TrimRight(s, " \t\n") }

// normalizeKnowledgeCandidates 解析模型输出的实体/概念候选列表。
func normalizeKnowledgeCandidates(values any, kind string) []knowledgeCandidate {
	list, ok := values.([]any)
	if !ok {
		return nil
	}
	seen := map[string]struct{}{}
	var out []knowledgeCandidate
	for _, raw := range list {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name := trimSpace(optString(entry["name"]))
		if name == "" {
			continue
		}
		pageKey := normalizePageKeyForKind(optString(entry["pageKey"]), kind, name)
		if _, dup := seen[pageKey]; dup {
			continue
		}
		seen[pageKey] = struct{}{}
		aliases := normalizeStringList(entry["aliases"], -1)
		filtered := aliases[:0]
		for _, alias := range aliases {
			if alias != name {
				filtered = append(filtered, alias)
			}
		}
		if len(filtered) > 12 {
			filtered = filtered[:12]
		}
		summary := truncateRunes(trimSpace(optString(entry["summary"])), 500)
		out = append(out, knowledgeCandidate{
			kind: kind, name: name, pageKey: pageKey,
			aliases: filtered, summary: summary, categoryPath: []string{},
		})
	}
	return out
}

// limitKnowledgeCandidates 实体/概念交错去重限量。
func limitKnowledgeCandidates(entities, concepts []knowledgeCandidate, limit int) []knowledgeCandidate {
	result := []knowledgeCandidate{}
	seenNames := map[string]struct{}{}
	identity := func(name string) string {
		lowered := strings.ToLower(name)
		punct := regexp.MustCompile(`[\s\p{P}\p{S}]+`)
		return punct.ReplaceAllString(lowered, "")
	}
	maxLength := len(entities)
	if len(concepts) > maxLength {
		maxLength = len(concepts)
	}
	for index := 0; index < maxLength && len(result) < limit; index++ {
		for _, pair := range [][2]*knowledgeCandidate{
			{entityAt(entities, index), entityAt(concepts, index)},
		} {
			for _, candidatePtr := range pair {
				if candidatePtr == nil || len(result) >= limit {
					continue
				}
				id := identity(candidatePtr.name)
				if id != "" {
					if _, dup := seenNames[id]; dup {
						continue
					}
					seenNames[id] = struct{}{}
				}
				result = append(result, *candidatePtr)
			}
		}
	}
	return result
}

func entityAt(list []knowledgeCandidate, index int) *knowledgeCandidate {
	if index < len(list) {
		return &list[index]
	}
	return nil
}

// normalizeKnowledgeRelations 校验关系两端均为候选并去重限量。
func normalizeKnowledgeRelations(values any, candidateKeys map[string]struct{}) []knowledgeRelation {
	list, ok := values.([]any)
	if !ok {
		return nil
	}
	seen := map[string]struct{}{}
	var out []knowledgeRelation
	for _, raw := range list {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		rawFrom := optString(entry["fromPageKey"])
		rawTo := optString(entry["toPageKey"])
		fromPageKey := normalizePageKeyForKind(rawFrom, inferPageKind(rawFrom), rawFrom)
		toPageKey := normalizePageKeyForKind(rawTo, inferPageKind(rawTo), rawTo)
		if _, okFrom := candidateKeys[fromPageKey]; !okFrom {
			continue
		}
		if _, okTo := candidateKeys[toPageKey]; !okTo {
			continue
		}
		if fromPageKey == toPageKey {
			continue
		}
		relationType := trimSpace(optString(entry["relationType"]))
		if relationType == "" {
			relationType = "关联"
		}
		relationType = truncateRunes(relationType, 60)
		description := truncateRunes(trimSpace(optString(entry["description"])), 300)
		key := fromPageKey + "|" + toPageKey + "|" + relationType
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, knowledgeRelation{fromPageKey, toPageKey, relationType, description})
		if len(out) >= 160 {
			break
		}
	}
	return out
}

func buildWholeDocumentContext(contentMd string) string {
	normalized := trimSpace(regexp.MustCompile(`\r\n?`).ReplaceAllString(contentMd, "\n"))
	if len([]rune(normalized)) <= wikiDocumentMaxChars {
		return normalized
	}
	runes := []rune(normalized)
	headLength := wikiDocumentMaxChars * 62 / 100
	tailLength := wikiDocumentMaxChars - headLength
	return string(runes[:headLength]) +
		"\n\n<!-- 文档过长，中间内容已省略；以下继续保留文档末尾 -->\n\n" +
		string(runes[len(runes)-tailLength:])
}

func renderExistingPageCatalog(pages []existingKnowledgePage) string {
	if len(pages) == 0 {
		return "（暂无既有页面）"
	}
	if len(pages) > 300 {
		pages = pages[:300]
	}
	lines := []string{}
	for _, page := range pages {
		line := "- " + page.pageKey + " | " + page.kind + " | " + page.title
		if len(page.aliases) > 0 {
			line += " | 别名：" + strings.Join(page.aliases, "、")
		}
		if page.summary != "" {
			line += " | 摘要：" + truncateRunes(page.summary, 180)
		}
		if len(page.categoryPath) > 0 {
			line += " | 目录：" + strings.Join(page.categoryPath, " / ")
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// extractDocumentCandidates 整文候选抽取；失败回落本地摘要 + 空候选。
func extractDocumentCandidates(ctx context.Context, userID int64, knowledgeBaseName, articleTitle, contentMd string, existingPages []existingKnowledgePage) (string, []knowledgeCandidate, []knowledgeRelation, []string) {
	fallbackSummary := localDocumentSummary(contentMd)
	answer, err := ChatInvoker(ctx, ChatRequest{
		UserID: userID,
		SystemPrompt: strings.Join([]string{
			"你是 Wiki 候选抽取器。必须从整篇 Markdown 识别被实质讨论的实体、概念及它们之间的关系；不要根据预先切片分别抽取。",
			"实体（entity）是具有独立身份、可以被明确指代的具体对象：人物、组织、产品、应用/工具、平台、操作系统、地点、协议、具名技术/服务或事件。",
			"概念（concept）是可以被解释、学习或复用的知识点：功能/能力、方法、流程、规则、原理、配置方式、安全机制、理论或抽象主题。",
			"章节标题或聚合标签只适合作为目录，不得抽成页面；通用名词和一带而过的技术名也不要抽取。",
			"只保留正文有专门段落、多项列表、独立小节或至少 2-3 句具体说明的条目。目标是紧凑、可阅读的知识集合，通常 5-20 项，最多 24 项。",
			"若一个名称表示具体产品/工具本身，即使它属于某类技术，也只能放入 entities；只有抽象知识才放入 concepts。不得跨两类重复。",
			"existing_pages 中若存在同一对象，必须复用其 pageKey。",
			"relations 只描述本次 candidates 之间有原文依据的关系。",
			"只输出 JSON，不要 Markdown 围栏。结构：",
			"{\"documentSummary\":\"...\",\"entities\":[{\"name\":\"\",\"pageKey\":\"entity/...\",\"aliases\":[],\"summary\":\"\"}],\"concepts\":[同结构],\"relations\":[{\"fromPageKey\":\"...\",\"toPageKey\":\"...\",\"relationType\":\"实现\",\"description\":\"...\"}]}。",
		}, "\n"),
		Message: strings.Join([]string{
			"知识库：" + knowledgeBaseName,
			"文档标题：" + articleTitle,
			"<existing_pages>",
			renderExistingPageCatalog(existingPages),
			"</existing_pages>",
			"<document_markdown>",
			buildWholeDocumentContext(contentMd),
			"</document_markdown>",
		}, "\n\n"),
		Op: "kb.build.extraction",
	})
	if err != nil {
		return fallbackSummary, nil, nil, []string{"Wiki 候选抽取失败：" + err.Error()}
	}
	parsed := extractJSONObjects(answer)
	if parsed == nil {
		return fallbackSummary, nil, nil, []string{"Wiki 候选抽取结果不是有效 JSON"}
	}
	candidates := limitKnowledgeCandidates(
		normalizeKnowledgeCandidates(parsed["entities"], "entity"),
		normalizeKnowledgeCandidates(parsed["concepts"], "concept"),
		wikiItemLimit,
	)
	keys := map[string]struct{}{}
	for _, c := range candidates {
		keys[c.pageKey] = struct{}{}
	}
	relations := normalizeKnowledgeRelations(parsed["relations"], keys)
	documentSummary := fallbackSummary
	if s := trimSpace(optString(parsed["documentSummary"])); s != "" {
		documentSummary = truncateRunes(s, 800)
	}
	return documentSummary, candidates, relations, nil
}

// planKnowledgeTaxonomy 全局目录规划；失败回落既有目录或空目录。
func planKnowledgeTaxonomy(ctx context.Context, userID int64, knowledgeBaseName, articleTitle string, candidates []knowledgeCandidate, existingPages []existingKnowledgePage, warnings []string) ([]knowledgeCandidate, []string) {
	if len(candidates) == 0 {
		return candidates, warnings
	}
	existingCategoryByKey := map[string][]string{}
	var taxonomyPaths []string
	for _, page := range existingPages {
		path := normalizeKnowledgeCategoryPath(page.categoryPath)
		if page.buildVersion >= ArticleKnowledgeBuildVersion && len(path) > 0 {
			existingCategoryByKey[page.pageKey] = path
			taxonomyPaths = append(taxonomyPaths, strings.Join(path, " / "))
		}
	}
	sort.Strings(taxonomyPaths)
	taxonomyPaths = dedupeStrings(taxonomyPaths)
	if len(taxonomyPaths) > 120 {
		taxonomyPaths = taxonomyPaths[:120]
	}
	foldersText := "（暂无可复用目录）"
	if len(taxonomyPaths) > 0 {
		lines := make([]string, 0, len(taxonomyPaths))
		for _, p := range taxonomyPaths {
			lines = append(lines, "- "+p)
		}
		foldersText = strings.Join(lines, "\n")
	}
	itemsText := ""
	for _, candidate := range candidates {
		item := "- pageKey: " + candidate.pageKey + " | type: " + candidate.kind + " | title: " + candidate.name
		if candidate.summary != "" {
			item += " | about: " + candidate.summary
		}
		itemsText += item + "\n"
	}
	parsedAny := false
	answer, err := ChatInvoker(ctx, ChatRequest{
		UserID: userID,
		SystemPrompt: strings.Join([]string{
			"你是 Wiki 导航目录规划器。候选实体和概念已经抽取完成，请一次性为整批候选规划一棵统一、浅层、可复用的中文目录树。",
			"目录只负责语义分组；entity/concept 是页面类型元数据，绝不能建立「实体」「概念」两个类型根目录。",
			"每项输出从宽到窄的 category path，最多 2 级，优先只用 1 级。一级目录通常不超过 6 个。",
			"目录数量必须显著少于页面数量。禁止一页一目录，禁止把页面标题原样再建成叶子目录。",
			"每个 requested_items 的 pageKey 必须恰好出现一次。只输出 JSON，不要 Markdown 围栏。",
			"输出结构：{\"assignments\":[{\"pageKey\":\"entity-xxx\",\"path\":[\"一级\",\"二级\"]}]}。",
		}, "\n"),
		Message: strings.Join([]string{
			"知识库：" + knowledgeBaseName,
			"当前文档：" + articleTitle,
			"<existing_folders>",
			foldersText,
			"</existing_folders>",
			"<requested_items>",
			itemsText,
			"</requested_items>",
		}, "\n\n"),
		Op: "kb.build.taxonomy",
	})
	assignments := map[string][]string{}
	if err == nil {
		if parsed := extractJSONObjects(answer); parsed != nil {
			parsedAny = true
			if list, ok := parsed["assignments"].([]any); ok {
				candidateByKey := map[string]struct{}{}
				for _, c := range candidates {
					candidateByKey[c.pageKey] = struct{}{}
				}
				for _, raw := range list {
					entry, ok := raw.(map[string]any)
					if !ok {
						continue
					}
					rawPageKey := trimSpace(optString(entry["pageKey"]))
					if rawPageKey == "" {
						rawPageKey = trimSpace(optString(entry["slug"]))
					}
					if rawPageKey == "" {
						continue
					}
					pageKey := rawPageKey
					if _, exists := candidateByKey[pageKey]; !exists {
						pageKey = normalizePageKeyForKind(rawPageKey, inferPageKind(rawPageKey), rawPageKey)
					}
					if _, exists := candidateByKey[pageKey]; !exists {
						continue
					}
					if _, dup := assignments[pageKey]; dup {
						continue
					}
					pathValue := entry["path"]
					if pathValue == nil {
						pathValue = entry["categoryPath"]
					}
					assignments[pageKey] = normalizeKnowledgeCategoryPath(pathValue)
				}
			}
		}
	} else {
		warnings = append(warnings, "知识目录规划失败："+err.Error())
	}
	if err == nil && !parsedAny {
		warnings = append(warnings, "知识目录规划结果不是有效 JSON")
	}
	out := make([]knowledgeCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		categoryPath := existingCategoryByKey[candidate.pageKey]
		if categoryPath == nil {
			categoryPath = assignments[candidate.pageKey]
		}
		if categoryPath == nil {
			categoryPath = []string{}
		}
		cloned := candidate
		cloned.categoryPath = categoryPath
		out = append(out, cloned)
	}
	if len(warnings) > 8 {
		warnings = warnings[:8]
	}
	return out, warnings
}

// normalizeKnowledgeCategoryPath 对应同名函数：字符串或数组归一为最多 2 级路径。
func normalizeKnowledgeCategoryPath(value any) []string {
	var raw []any
	switch v := value.(type) {
	case []any:
		raw = v
	case string:
		for _, part := range regexp.MustCompile(`[/／|｜>]`).Split(v, -1) {
			raw = append(raw, part)
		}
	default:
		return []string{}
	}
	cleanRe := regexp.MustCompile(`[/／|｜>]`)
	bannedRe := regexp.MustCompile(`(?i)^(实体|概念|entity|concept)$`)
	var parts []string
	for _, item := range raw {
		part := cleanRe.ReplaceAllString(trimSpace(toStr(item)), "")
		if part == "" || bannedRe.MatchString(part) {
			continue
		}
		parts = append(parts, part)
	}
	if len(parts) > 2 {
		parts = parts[:2]
	}
	return parts
}

// ===== 页面物化 =====

func renderWikiCandidateCatalog(candidates []knowledgeCandidate) string {
	lines := make([]string, 0, len(candidates))
	for _, c := range candidates {
		line := "- " + c.pageKey + " | " + c.kind + " | " + c.name
		if len(c.aliases) > 0 {
			line += " | 别名：" + strings.Join(c.aliases, "、")
		}
		if c.summary != "" {
			line += " | 摘要：" + c.summary
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func renderRelationCatalog(relations []knowledgeRelation) string {
	if len(relations) == 0 {
		return "（未抽取到有依据的页面关系）"
	}
	lines := make([]string, 0, len(relations))
	for _, r := range relations {
		line := r.fromPageKey + " --" + r.relationType + "--> " + r.toPageKey
		if r.description != "" {
			line += "：" + r.description
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func buildFallbackWikiPage(candidate knowledgeCandidate, relations []knowledgeRelation) string {
	var related []knowledgeRelation
	for _, relation := range relations {
		if relation.fromPageKey == candidate.pageKey || relation.toPageKey == candidate.pageKey {
			related = append(related, relation)
		}
	}
	parts := []string{"# " + candidate.name, "", firstNonEmpty(candidate.summary, "暂无足够的原文信息生成详细页面。")}
	if len(related) > 0 {
		parts = append(parts, "", "## 相关知识")
		for _, relation := range related {
			target := relation.toPageKey
			if relation.fromPageKey == candidate.pageKey {
				target = relation.toPageKey
			} else {
				target = relation.fromPageKey
			}
			parts = append(parts, "- [["+target+"|"+target+"]]："+firstNonEmpty(relation.description, relation.relationType))
		}
	}
	return strings.Join(parts, "\n")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

var processingMetaRes = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^SUMMARY:\s*[^\n]*\n+`),
	regexp.MustCompile(`(?im)^依据切片[^\n]*\n?`),
	regexp.MustCompile("(?i)`?chunk-\\d+`?"),
}

func normalizeGeneratedPageContent(value any, candidate knowledgeCandidate) string {
	raw := trimSpace(optString(value))
	if raw == "" {
		return "# " + candidate.name + "\n\n" + firstNonEmpty(candidate.summary, "暂无详细说明。")
	}
	for _, re := range processingMetaRes {
		raw = re.ReplaceAllString(raw, "")
	}
	raw = trimSpace(raw)
	hasTitle := regexp.MustCompile(`(?m)^#\s+`).MatchString(raw)
	if hasTitle {
		return raw
	}
	return "# " + candidate.name + "\n\n" + raw
}

// materializeWikiPages 批量生成候选页面正文；单页失败回落候选摘要页。
func materializeWikiPages(ctx context.Context, userID int64, knowledgeBaseName, articleTitle, contentMd string, candidates []knowledgeCandidate, relations []knowledgeRelation, warnings []string) ([]extractedItem, []string) {
	if len(candidates) == 0 {
		return nil, warnings
	}
	batches := make([][]knowledgeCandidate, 0, (len(candidates)+wikiPageBatchSize-1)/wikiPageBatchSize)
	for start := 0; start < len(candidates); start += wikiPageBatchSize {
		end := start + wikiPageBatchSize
		if end > len(candidates) {
			end = len(candidates)
		}
		batches = append(batches, candidates[start:end])
	}
	generatedByKey := map[string]genPage{}
	outputs := mapWithConcurrency(batches, wikiPageBatchConcurrency, func(batch []knowledgeCandidate) []genPage {
		fallback := make([]genPage, 0, len(batch))
		for _, candidate := range batch {
			fallback = append(fallback, genPage{
				pageKey:   candidate.pageKey,
				summary:   candidate.summary,
				contentMd: buildFallbackWikiPage(candidate, relations),
			})
		}
		answer, err := ChatInvoker(ctx, ChatRequest{
			UserID: userID,
			SystemPrompt: strings.Join([]string{
				"你是 Wiki 页面编译器。候选已经由整篇文档抽取完成，现在为每个候选生成一篇独立、完整、可直接阅读的 Markdown 页面。",
				"页面正文必须依据 document_markdown 中与该候选直接相关的内容，禁止补充外部事实、禁止把邻近对象的事实混入本页。",
				"不要输出 chunk id、切片编号、处理过程或来源说明；来源由系统单独保存。",
				"以 '# 页面标题' 开头；正文提到相关页面名称时首次出现使用 [[pageKey|显示名称]] 链接；不得发明页面 key，不得自链接。",
				"对每个 requested_pages 条目返回一项，只输出 JSON：{\"pages\":[{\"pageKey\":\"\",\"summary\":\"15-80字独立摘要\",\"contentMd\":\"完整 Markdown\"}]}。",
				"JSON 字符串中的换行必须使用转义字符。",
			}, "\n"),
			Message: strings.Join([]string{
				"<valid_wiki_pages>",
				renderWikiCandidateCatalog(candidates),
				"</valid_wiki_pages>",
				"<relations>",
				renderRelationCatalog(relations),
				"</relations>",
				"<requested_pages>",
				renderWikiCandidateCatalog(batch),
				"</requested_pages>",
				"<document_markdown>",
				buildWholeDocumentContext(contentMd),
				"</document_markdown>",
			}, "\n\n"),
			Op: "kb.build.pages",
		})
		if err != nil {
			warnings = append(warnings, "Wiki 页面生成失败："+err.Error())
			return fallback
		}
		parsed := extractJSONObjects(answer)
		if parsed == nil {
			return fallback
		}
		rawPages, _ := parsed["pages"].([]any)
		pageByKey := map[string]map[string]any{}
		for _, raw := range rawPages {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			rawKey := optString(entry["pageKey"])
			key := normalizePageKeyForKind(rawKey, inferPageKind(rawKey), rawKey)
			pageByKey[key] = entry
		}
		out := make([]genPage, 0, len(batch))
		for index, candidate := range batch {
			value, ok := pageByKey[candidate.pageKey]
			if !ok {
				out = append(out, fallback[index])
				continue
			}
			summary := candidate.summary
			if s := trimSpace(optString(value["summary"])); s != "" {
				summary = truncateRunes(s, 500)
			}
			out = append(out, genPage{
				pageKey:   candidate.pageKey,
				summary:   summary,
				contentMd: normalizeGeneratedPageContent(value["contentMd"], candidate),
			})
		}
		return out
	})
	for _, batchOut := range outputs {
		for _, page := range batchOut {
			generatedByKey[page.pageKey] = page
		}
	}

	items := make([]extractedItem, 0, len(candidates))
	for _, candidate := range candidates {
		var pageRelations []knowledgeRelation
		for _, relation := range relations {
			if relation.fromPageKey == candidate.pageKey || relation.toPageKey == candidate.pageKey {
				pageRelations = append(pageRelations, relation)
			}
		}
		relatedSet := dedupeStrings(func() []string {
			keys := []string{}
			for _, relation := range pageRelations {
				if relation.fromPageKey == candidate.pageKey {
					keys = append(keys, relation.toPageKey)
				} else {
					keys = append(keys, relation.fromPageKey)
				}
			}
			return keys
		}())
		generated, ok := generatedByKey[candidate.pageKey]
		summary := candidate.summary
		content := buildFallbackWikiPage(candidate, relations)
		if ok {
			if generated.summary != "" {
				summary = generated.summary
			}
			content = generated.contentMd
		}
		items = append(items, extractedItem{
			candidate:       candidate,
			summary:         summary,
			contentMd:       content,
			relatedPageKeys: relatedSet,
			relations:       pageRelations,
		})
	}
	uniqueWarnings := dedupeStrings(warnings)
	if len(uniqueWarnings) > 8 {
		uniqueWarnings = uniqueWarnings[:8]
	}
	return items, uniqueWarnings
}

type genPage struct {
	pageKey   string
	summary   string
	contentMd string
}

// extractedItem 物化结果条目。
type extractedItem struct {
	candidate       knowledgeCandidate
	summary         string
	contentMd       string
	relatedPageKeys []string
	relations       []knowledgeRelation
}

// existingKnowledgePage 已存在的实体/概念页（供复用 pageKey 与目录）。
type existingKnowledgePage struct {
	pageKey      string
	title        string
	kind         string // entity | concept
	aliases      []string
	summary      string
	categoryPath []string
	buildVersion int64
}
