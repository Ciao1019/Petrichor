package runtime

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// WikiMentionTarget 是回答渲染前使用的轻量 Wiki 词典。
// citationIndex 显式保留 null，保证流式协议与前端 WikiMentionTarget 一致。
type WikiMentionTarget struct {
	PageKey       string   `json:"pageKey"`
	Title         string   `json:"title"`
	Aliases       []string `json:"aliases"`
	Kind          string   `json:"kind,omitempty"`
	CitationIndex *int     `json:"citationIndex"`
}

type wikiMentionCandidate struct {
	PageKey string   `json:"pageKey"`
	Title   string   `json:"title"`
	Aliases []string `json:"aliases"`
	Kind    string   `json:"kind"`
}

// Markdown 表格中的 wikilink 分隔符会写成 `\|`，普通正文则是 `|`；两种都要识别。
var explicitWikiMentionPattern = regexp.MustCompile(`\[\[([^\]|\\]+)(?:\\?\|([^\]]+))?]]`)

func inferWikiMentionKind(pageKey string) string {
	lower := strings.ToLower(strings.TrimSpace(pageKey))
	for _, kind := range []string{"concept", "entity"} {
		if lower == kind || strings.HasPrefix(lower, kind+"-") || strings.HasPrefix(lower, kind+"/") {
			return kind
		}
	}
	return ""
}

func isWikiMentionKind(kind, pageKey string) bool {
	resolved := strings.ToLower(strings.TrimSpace(kind))
	if resolved == "" || resolved == "wiki_page" {
		resolved = inferWikiMentionKind(pageKey)
	}
	return resolved == "concept" || resolved == "entity"
}

func wikiMentionCandidatesFromText(text string) []wikiMentionCandidate {
	matches := explicitWikiMentionPattern.FindAllStringSubmatch(text, -1)
	out := make([]wikiMentionCandidate, 0, len(matches))
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		pageKey := strings.TrimSpace(match[1])
		label := pageKey
		if len(match) > 2 && strings.TrimSpace(match[2]) != "" {
			label = strings.TrimSpace(match[2])
			label = strings.NewReplacer(`\|`, `|`, `\[`, `[`, `\]`, `]`, `\\`, `\`).Replace(label)
		}
		kind := inferWikiMentionKind(pageKey)
		if pageKey == "" || label == "" || kind == "" {
			continue
		}
		out = append(out, wikiMentionCandidate{
			PageKey: pageKey,
			Title:   label,
			Aliases: []string{},
			Kind:    kind,
		})
	}
	return out
}

func stringList(value any) []string {
	var raw []string
	switch list := value.(type) {
	case []string:
		raw = list
	case []any:
		for _, item := range list {
			if text, ok := item.(string); ok {
				raw = append(raw, text)
			}
		}
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		item = strings.TrimSpace(item)
		key := strings.ToLower(item)
		if item == "" || seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, item)
	}
	return out
}

// CollectWikiMentionTargets 合并本轮深读证据与检索候选。
// 深读页优先；检索观察同时兼容普通知识检索的 hits 和 Wiki 检索的 items。
func CollectWikiMentionTargets(observations *ObservationStore, evidence *EvidenceStore) []WikiMentionTarget {
	byKey := map[string]*WikiMentionTarget{}
	order := make([]string, 0, 16)
	add := func(candidate wikiMentionCandidate, citationIndex *int) {
		pageKey := strings.TrimSpace(candidate.PageKey)
		title := strings.TrimSpace(candidate.Title)
		if pageKey == "" || title == "" || !isWikiMentionKind(candidate.Kind, pageKey) {
			return
		}
		kind := strings.ToLower(strings.TrimSpace(candidate.Kind))
		if kind == "" || kind == "wiki_page" {
			kind = inferWikiMentionKind(pageKey)
		}
		current := byKey[pageKey]
		if current == nil {
			current = &WikiMentionTarget{
				PageKey: pageKey, Title: title, Aliases: []string{}, Kind: kind,
				CitationIndex: citationIndex,
			}
			byKey[pageKey] = current
			order = append(order, pageKey)
		} else {
			if current.Title == current.PageKey && title != pageKey {
				current.Title = title
			}
			if current.Kind == "" && kind != "" {
				current.Kind = kind
			}
			if current.CitationIndex == nil && citationIndex != nil {
				current.CitationIndex = citationIndex
			}
		}
		current.Aliases = stringList(append(anyStrings(current.Aliases), anyStrings(candidate.Aliases)...))
	}

	if evidence != nil {
		for _, item := range evidence.All() {
			pageKey, _ := item.Metadata["pageKey"].(string)
			kind, _ := item.Metadata["kind"].(string)
			if pageKey == "" {
				continue
			}
			index := evidence.CitationIndex(item.ID)
			add(wikiMentionCandidate{
				PageKey: pageKey,
				Title:   firstNonBlank(item.Title, pageKey),
				Aliases: stringList(item.Metadata["aliases"]),
				Kind:    kind,
			}, &index)
			// Wiki 正文已经用 [[pageKey|标题]] 明确声明了页面关系；即使关系表尚未
			// 同步完整，也应把这些显式链接作为本轮高亮词典，尤其要兼容表格里的 \|。
			for _, linked := range wikiMentionCandidatesFromText(item.Content) {
				add(linked, nil)
			}
		}
	}

	if observations != nil {
		for _, observation := range observations.All() {
			if observation.IsError || len(observation.Data) == 0 {
				continue
			}
			var data struct {
				Hits  []wikiMentionCandidate `json:"hits"`
				Items []wikiMentionCandidate `json:"items"`
				Pages []wikiMentionCandidate `json:"pages"`
			}
			if json.Unmarshal(observation.Data, &data) != nil {
				continue
			}
			candidates := append(data.Hits, data.Items...)
			candidates = append(candidates, data.Pages...)
			for _, candidate := range candidates {
				add(candidate, nil)
			}
		}
	}

	if len(order) > 64 {
		order = order[:64]
	}
	out := make([]WikiMentionTarget, 0, len(order))
	for _, pageKey := range order {
		out = append(out, *byKey[pageKey])
	}
	return out
}

func anyStrings(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// EmitWikiMentionTargets 必须在 final_answer_started 之前调用：这样首个可见字符到达时，
// 表格和正文走的是同一份 Wiki 词典，不依赖模型是否恰好写出了 [[..]]。
func EmitWikiMentionTargets(events *AgentEventEmitter, observations *ObservationStore, evidence *EvidenceStore) []WikiMentionTarget {
	targets := CollectWikiMentionTargets(observations, evidence)
	if events != nil && len(targets) > 0 {
		events.Emit("wiki_mention_targets", map[string]any{"targets": targets})
	}
	return targets
}

func wikiMentionForms(target WikiMentionTarget) []string {
	seen := map[string]bool{}
	forms := make([]string, 0, len(target.Aliases)+1)
	for _, value := range append([]string{target.Title}, target.Aliases...) {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if utf8.RuneCountInString(value) < 2 || seen[key] {
			continue
		}
		seen[key] = true
		forms = append(forms, value)
	}
	sort.SliceStable(forms, func(i, j int) bool {
		return utf8.RuneCountInString(forms[i]) > utf8.RuneCountInString(forms[j])
	})
	return forms
}

func isASCIIWordByte(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || value == '_'
}

func hasWikiMentionBoundary(text string, index, length int, form string) bool {
	if form == "" {
		return false
	}
	if isASCIIWordByte(form[0]) && index > 0 && isASCIIWordByte(text[index-1]) {
		return false
	}
	if isASCIIWordByte(form[len(form)-1]) && index+length < len(text) && isASCIIWordByte(text[index+length]) {
		return false
	}
	return true
}

type wikiMentionMatch struct {
	index int
	label string
}

func findWikiMention(text string, target WikiMentionTarget) *wikiMentionMatch {
	var best *wikiMentionMatch
	for _, form := range wikiMentionForms(target) {
		pattern, err := regexp.Compile(`(?i)` + regexp.QuoteMeta(form))
		if err != nil {
			continue
		}
		for _, location := range pattern.FindAllStringIndex(text, -1) {
			if !hasWikiMentionBoundary(text, location[0], location[1]-location[0], form) {
				continue
			}
			matched := text[location[0]:location[1]]
			if best == nil || location[0] < best.index || location[0] == best.index && len(matched) > len(best.label) {
				best = &wikiMentionMatch{index: location[0], label: matched}
			}
			break
		}
	}
	return best
}

func escapeWikiMentionLabel(value string) string {
	replacer := strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`, `|`, `\|`)
	return replacer.Replace(value)
}

func existingWikiMentionKeys(markdown string) map[string]bool {
	used := map[string]bool{}
	for _, match := range explicitWikiMentionPattern.FindAllStringSubmatch(markdown, -1) {
		if len(match) > 1 && strings.TrimSpace(match[1]) != "" {
			used[strings.TrimSpace(match[1])] = true
		}
	}
	return used
}

func annotateWikiPlainText(text string, targets []WikiMentionTarget, used map[string]bool) string {
	var output strings.Builder
	remaining := text
	for remaining != "" {
		bestTarget := -1
		var best *wikiMentionMatch
		for index, target := range targets {
			if used[target.PageKey] {
				continue
			}
			match := findWikiMention(remaining, target)
			if match == nil {
				continue
			}
			if best == nil || match.index < best.index || match.index == best.index && len(match.label) > len(best.label) {
				bestTarget = index
				best = match
			}
		}
		if best == nil || bestTarget < 0 {
			output.WriteString(remaining)
			break
		}
		target := targets[bestTarget]
		output.WriteString(remaining[:best.index])
		output.WriteString("[[" + target.PageKey + "|" + escapeWikiMentionLabel(best.label) + "]]")
		used[target.PageKey] = true
		remaining = remaining[best.index+len(best.label):]
	}
	return output.String()
}

func protectedMarkdownEnd(line string, start int) int {
	if strings.HasPrefix(line[start:], "[[") {
		if end := strings.Index(line[start+2:], "]]"); end >= 0 {
			return start + 2 + end + 2
		}
	}
	if line[start] == '`' {
		run := 1
		for start+run < len(line) && line[start+run] == '`' {
			run++
		}
		if end := strings.Index(line[start+run:], strings.Repeat("`", run)); end >= 0 {
			return start + run + end + run
		}
	}
	linkStart := start
	if strings.HasPrefix(line[start:], "![") {
		linkStart++
	}
	if line[linkStart] == '[' {
		if middle := strings.Index(line[linkStart+1:], "]("); middle >= 0 {
			bodyStart := linkStart + 1 + middle + 2
			if end := strings.IndexByte(line[bodyStart:], ')'); end >= 0 {
				return bodyStart + end + 1
			}
		}
	}
	if line[start] == '<' {
		if end := strings.IndexByte(line[start+1:], '>'); end >= 0 {
			return start + 1 + end + 1
		}
	}
	return start
}

func annotateWikiMarkdownLine(line string, targets []WikiMentionTarget, used map[string]bool) string {
	var output strings.Builder
	plainStart := 0
	for index := 0; index < len(line); {
		end := protectedMarkdownEnd(line, index)
		if end == index {
			index++
			continue
		}
		output.WriteString(annotateWikiPlainText(line[plainStart:index], targets, used))
		output.WriteString(line[index:end])
		index = end
		plainStart = end
	}
	output.WriteString(annotateWikiPlainText(line[plainStart:], targets, used))
	return output.String()
}

// AnnotateNormalQaWikiMentions 将真实实体/概念的首次裸文本提及补成 Wiki 链接。
// 表格行不做特殊排除，因此单元格与正文使用完全相同的规则；代码、已有链接、HTML
// 和 fenced code 保持原样。
func AnnotateNormalQaWikiMentions(markdown string, targets []WikiMentionTarget) string {
	if markdown == "" || len(targets) == 0 {
		return markdown
	}
	mentionable := make([]WikiMentionTarget, 0, len(targets))
	for _, target := range targets {
		if isWikiMentionKind(target.Kind, target.PageKey) {
			mentionable = append(mentionable, target)
		}
	}
	if len(mentionable) == 0 {
		return markdown
	}
	used := existingWikiMentionKeys(markdown)
	lines := strings.Split(markdown, "\n")
	inFence := false
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inFence = !inFence
			continue
		}
		if !inFence {
			lines[index] = annotateWikiMarkdownLine(line, mentionable, used)
		}
	}
	return strings.Join(lines, "\n")
}
