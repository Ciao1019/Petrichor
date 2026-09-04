package kb

import (
	"context"
	"regexp"
	"sort"
	"strings"
)

const knowledgeResolutionExistingBatchSize = 120

type knowledgeResolutionPlan struct {
	canonicalByKey map[string]string
	relations      []knowledgeRelation
}

type knowledgeResolutionEdge struct {
	from string
	to   string
}

// planKnowledgeResolution 让模型在同一知识库范围内区分“同一知识”与“相关知识”：
// 前者映射到同一个 canonical pageKey，后者保留成独立页面并产生关系。
func planKnowledgeResolution(
	ctx context.Context,
	userID int64,
	profile compileProfile,
	current []knowledgeCandidate,
	existing []existingKnowledgePage,
) (knowledgeResolutionPlan, []string) {
	identity := make(map[string]string, len(current))
	for _, candidate := range current {
		identity[candidate.pageKey] = candidate.pageKey
	}
	plan := knowledgeResolutionPlan{canonicalByKey: identity}
	if len(current) == 0 {
		return plan, nil
	}

	existing = append([]existingKnowledgePage(nil), existing...)
	sort.Slice(existing, func(left, right int) bool {
		if existing[left].kind != existing[right].kind {
			return existing[left].kind < existing[right].kind
		}
		if existing[left].title != existing[right].title {
			return existing[left].title < existing[right].title
		}
		return existing[left].pageKey < existing[right].pageKey
	})

	windows := [][]existingKnowledgePage{nil}
	if len(existing) > 0 {
		windows = windows[:0]
		for start := 0; start < len(existing); start += knowledgeResolutionExistingBatchSize {
			end := min(start+knowledgeResolutionExistingBatchSize, len(existing))
			windows = append(windows, existing[start:end])
		}
	}

	edges := []knowledgeResolutionEdge{}
	rawRelations := []knowledgeRelation{}
	warnings := []string{}
	for windowIndex, window := range windows {
		parsed, err := invokeKnowledgeBuildJSON(ctx, ChatRequest{
			UserID: userID,
			SystemPrompt: profile.systemPrompt(
				"你是知识库的全局语义消歧与关系规划器。请比较 current_pages、同批 current_pages 之间，以及 existing_pages 中已经存在的知识页面。",
				"只有两个页面指向完全同一个实体或可互换的同一概念时才能 merge，例如全称与缩写、中文名与英文名、明确同义词。主题相近、上下位、组成、功能、实现、依赖、配置对象都不是同一知识，绝不能合并。",
				"同一知识必须复用一个 canonicalPageKey，使不同文章的贡献聚合到同一 Wiki 页面；只是相关的知识要保持两个页面，并写入 relations。",
				"resolutions 必须覆盖每个 current page。action 只能是 keep 或 merge；keep 时 canonicalPageKey 等于自身；merge 时 canonicalPageKey 必须来自 current_pages 或本窗口 existing_pages，并且页面类型必须相同。",
				"relations 只返回有明确、稳定语义的关系。fromPageKey 必须来自 current_pages，toPageKey 必须来自 current_pages 或本窗口 existing_pages；相同对象不要建立关系而要 merge。不要仅因同目录或同文章就建立关系。",
				"关系类型使用简短中文动词，例如‘属于’‘包含’‘实现’‘依赖’‘替代’‘关联’。只输出 JSON，不要 Markdown 围栏。",
				"输出结构：{\"resolutions\":[{\"pageKey\":\"concept-a\",\"action\":\"merge\",\"canonicalPageKey\":\"concept-b\",\"reason\":\"同一概念\"}],\"relations\":[{\"fromPageKey\":\"concept-c\",\"toPageKey\":\"concept-b\",\"relationType\":\"依赖\",\"description\":\"...\"}]}。",
			),
			Message: strings.Join([]string{
				"<current_pages>", renderKnowledgeResolutionCurrent(current), "</current_pages>",
				"<existing_pages>", renderKnowledgeResolutionExisting(window), "</existing_pages>",
			}, "\n\n"),
			Op:        "kb.build.resolution",
			MaxTokens: 8_192,
		})
		if err != nil {
			warnings = append(warnings, knowledgeBuildFallbackWarning(
				"知识语义合并第 "+jsonInt(windowIndex+1)+" 批", "已保留独立页面", err,
			))
			continue
		}
		windowEdges, windowRelations := parseKnowledgeResolution(parsed, current, window)
		edges = append(edges, windowEdges...)
		rawRelations = append(rawRelations, windowRelations...)
	}

	plan.canonicalByKey = buildKnowledgeCanonicalMap(current, existing, edges)
	plan.relations = remapKnowledgeRelations(rawRelations, plan.canonicalByKey, current, existing)
	return plan, dedupeStrings(warnings)
}

func renderKnowledgeResolutionCurrent(candidates []knowledgeCandidate) string {
	if len(candidates) == 0 {
		return "（无）"
	}
	lines := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		line := "- " + candidate.pageKey + " | " + candidate.kind + " | " + candidate.name
		if len(candidate.aliases) > 0 {
			line += " | 别名：" + strings.Join(candidate.aliases, "、")
		}
		if candidate.summary != "" {
			line += " | 简述：" + truncateRunes(candidate.summary, 160)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func renderKnowledgeResolutionExisting(pages []existingKnowledgePage) string {
	if len(pages) == 0 {
		return "（当前知识库暂无既有知识页；仍需检查 current_pages 内部是否同义，并规划它们之间的关系）"
	}
	lines := make([]string, 0, len(pages))
	for _, page := range pages {
		line := "- " + page.pageKey + " | " + page.kind + " | " + page.title
		if len(page.aliases) > 0 {
			line += " | 别名：" + strings.Join(page.aliases, "、")
		}
		if page.summary != "" {
			line += " | 简述：" + truncateRunes(page.summary, 160)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func parseKnowledgeResolution(
	parsed map[string]any,
	current []knowledgeCandidate,
	existing []existingKnowledgePage,
) ([]knowledgeResolutionEdge, []knowledgeRelation) {
	currentKinds := map[string]string{}
	allKinds := map[string]string{}
	for _, candidate := range current {
		currentKinds[candidate.pageKey] = candidate.kind
		allKinds[candidate.pageKey] = candidate.kind
	}
	for _, page := range existing {
		allKinds[page.pageKey] = page.kind
	}
	currentAliases := knowledgeResolutionAliases(current, nil)
	allAliases := knowledgeResolutionAliases(current, existing)

	edges := []knowledgeResolutionEdge{}
	if resolutions, ok := parsed["resolutions"].([]any); ok {
		seen := map[string]struct{}{}
		for _, raw := range resolutions {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			from := currentAliases[knowledgeTaxonomyAlias(firstNonEmpty(
				optString(entry["pageKey"]), optString(entry["key"]),
			))]
			to := allAliases[knowledgeTaxonomyAlias(firstNonEmpty(
				optString(entry["canonicalPageKey"]), optString(entry["canonicalKey"]),
			))]
			if from == "" || to == "" || from == to || currentKinds[from] != allKinds[to] {
				continue
			}
			action := strings.ToLower(trimSpace(optString(entry["action"])))
			merge := action == "merge" || action == "reuse" || action == "same" || action == "合并"
			if action == "" {
				merge = rawBool(entry, "equivalent")
			}
			if !merge {
				continue
			}
			key := from + "\x00" + to
			if _, duplicate := seen[key]; duplicate {
				continue
			}
			seen[key] = struct{}{}
			edges = append(edges, knowledgeResolutionEdge{from: from, to: to})
		}
	}

	relations := []knowledgeRelation{}
	if values, ok := parsed["relations"].([]any); ok {
		seen := map[string]struct{}{}
		for _, raw := range values {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			from := currentAliases[knowledgeTaxonomyAlias(optString(entry["fromPageKey"]))]
			to := allAliases[knowledgeTaxonomyAlias(optString(entry["toPageKey"]))]
			if from == "" || to == "" || from == to {
				continue
			}
			relationType := truncateRunes(trimSpace(optString(entry["relationType"])), 60)
			if relationType == "" {
				relationType = "关联"
			}
			description := truncateRunes(trimSpace(optString(entry["description"])), 300)
			key := from + "\x00" + to + "\x00" + relationType
			if _, duplicate := seen[key]; duplicate {
				continue
			}
			seen[key] = struct{}{}
			relations = append(relations, knowledgeRelation{from, to, relationType, description})
		}
	}
	return edges, relations
}

func knowledgeResolutionAliases(current []knowledgeCandidate, existing []existingKnowledgePage) map[string]string {
	aliases := map[string]string{}
	add := func(alias, pageKey string) {
		key := knowledgeTaxonomyAlias(alias)
		if key == "" {
			return
		}
		if old, exists := aliases[key]; exists && old != pageKey {
			aliases[key] = ""
			return
		}
		aliases[key] = pageKey
	}
	for _, candidate := range current {
		add(candidate.pageKey, candidate.pageKey)
		add(candidate.name, candidate.pageKey)
		for _, alias := range candidate.aliases {
			add(alias, candidate.pageKey)
		}
	}
	for _, page := range existing {
		add(page.pageKey, page.pageKey)
		add(page.title, page.pageKey)
		for _, alias := range page.aliases {
			add(alias, page.pageKey)
		}
	}
	return aliases
}

func buildKnowledgeCanonicalMap(
	current []knowledgeCandidate,
	existing []existingKnowledgePage,
	edges []knowledgeResolutionEdge,
) map[string]string {
	parent := map[string]string{}
	find := func(key string) string { return key }
	var findRoot func(string) string
	findRoot = func(key string) string {
		root, exists := parent[key]
		if !exists {
			parent[key] = key
			return key
		}
		if root != key {
			parent[key] = findRoot(root)
		}
		return parent[key]
	}
	find = findRoot
	union := func(left, right string) {
		leftRoot, rightRoot := find(left), find(right)
		if leftRoot != rightRoot {
			parent[rightRoot] = leftRoot
		}
	}
	votes := map[string]int{}
	for _, candidate := range current {
		find(candidate.pageKey)
	}
	for _, edge := range edges {
		union(edge.from, edge.to)
		votes[edge.to]++
	}

	existingByKey := map[string]existingKnowledgePage{}
	for _, page := range existing {
		existingByKey[page.pageKey] = page
	}
	groups := map[string][]string{}
	for key := range parent {
		root := find(key)
		groups[root] = append(groups[root], key)
	}
	canonicalByRoot := map[string]string{}
	for root, keys := range groups {
		sort.Strings(keys)
		canonical := ""
		for _, key := range keys {
			page, exists := existingByKey[key]
			if !exists {
				continue
			}
			if canonical == "" || preferKnowledgeCanonical(page, existingByKey[canonical], votes[key], votes[canonical]) {
				canonical = key
			}
		}
		if canonical == "" {
			canonical = keys[0]
			for _, key := range keys[1:] {
				if votes[key] > votes[canonical] {
					canonical = key
				}
			}
		}
		canonicalByRoot[root] = canonical
	}

	result := map[string]string{}
	for _, candidate := range current {
		result[candidate.pageKey] = canonicalByRoot[find(candidate.pageKey)]
	}
	// 只有编译生成的存量页允许自动并入 canonical；手写页永远不自动删除。
	for key := range parent {
		page, exists := existingByKey[key]
		if !exists || !page.generated {
			continue
		}
		result[key] = canonicalByRoot[find(key)]
	}
	return result
}

func preferKnowledgeCanonical(candidate, current existingKnowledgePage, candidateVotes, currentVotes int) bool {
	if current.pageKey == "" {
		return true
	}
	if candidate.generated != current.generated {
		return !candidate.generated
	}
	if candidate.sourceCount != current.sourceCount {
		return candidate.sourceCount > current.sourceCount
	}
	if candidateVotes != currentVotes {
		return candidateVotes > currentVotes
	}
	return candidate.pageKey < current.pageKey
}

func canonicalKnowledgePageKey(pageKey string, canonicalByKey map[string]string) string {
	seen := map[string]struct{}{}
	current := pageKey
	for {
		next := canonicalByKey[current]
		if next == "" || next == current {
			return current
		}
		if _, cycle := seen[next]; cycle {
			return current
		}
		seen[current] = struct{}{}
		current = next
	}
}

func remapKnowledgeRelations(
	relations []knowledgeRelation,
	canonicalByKey map[string]string,
	current []knowledgeCandidate,
	existing []existingKnowledgePage,
) []knowledgeRelation {
	currentKeys := map[string]struct{}{}
	activeKeys := map[string]struct{}{}
	for _, candidate := range current {
		canonical := canonicalKnowledgePageKey(candidate.pageKey, canonicalByKey)
		currentKeys[canonical] = struct{}{}
		activeKeys[canonical] = struct{}{}
	}
	for _, page := range existing {
		activeKeys[canonicalKnowledgePageKey(page.pageKey, canonicalByKey)] = struct{}{}
	}
	seen := map[string]struct{}{}
	out := make([]knowledgeRelation, 0, len(relations))
	for _, relation := range relations {
		relation.fromPageKey = canonicalKnowledgePageKey(relation.fromPageKey, canonicalByKey)
		relation.toPageKey = canonicalKnowledgePageKey(relation.toPageKey, canonicalByKey)
		if relation.fromPageKey == relation.toPageKey {
			continue
		}
		if _, current := currentKeys[relation.fromPageKey]; !current {
			continue
		}
		if _, active := activeKeys[relation.toPageKey]; !active {
			continue
		}
		key := relation.fromPageKey + "\x00" + relation.toPageKey + "\x00" + relation.relationType
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, relation)
		if len(out) >= 160 {
			break
		}
	}
	return out
}

// applyKnowledgeResolution 把 AI 的 canonical 映射应用到已生成页面正文和原文关系。
// 同一篇文章内若抽出了多个同义候选，也会折叠成一个贡献，避免后写覆盖前写。
func applyKnowledgeResolution(
	items []extractedItem,
	documentRelations []knowledgeRelation,
	plan knowledgeResolutionPlan,
	existing []existingKnowledgePage,
) ([]extractedItem, []knowledgeCandidate, []knowledgeRelation, int) {
	existingByKey := map[string]existingKnowledgePage{}
	for _, page := range existing {
		existingByKey[page.pageKey] = page
	}
	currentByKey := map[string]knowledgeCandidate{}
	for _, item := range items {
		currentByKey[item.candidate.pageKey] = item.candidate
	}

	groups := map[string][]extractedItem{}
	order := []string{}
	mergedCount := 0
	for _, item := range items {
		canonical := canonicalKnowledgePageKey(item.candidate.pageKey, plan.canonicalByKey)
		if canonical != item.candidate.pageKey {
			mergedCount++
		}
		if _, exists := groups[canonical]; !exists {
			order = append(order, canonical)
		}
		groups[canonical] = append(groups[canonical], item)
	}

	resolved := make([]extractedItem, 0, len(order))
	for _, canonical := range order {
		members := groups[canonical]
		candidate := members[0].candidate
		if page, exists := existingByKey[canonical]; exists {
			candidate = knowledgeCandidate{
				kind: page.kind, name: page.title, pageKey: page.pageKey,
				aliases: page.aliases, summary: page.summary,
				categoryPath: page.categoryPath, taxonomyVersion: page.taxonomyVersion,
			}
		} else if selected, exists := currentByKey[canonical]; exists {
			candidate = selected
		}
		aliases := append([]string(nil), candidate.aliases...)
		sourceChunkKeys := append([]string(nil), candidate.sourceChunkKeys...)
		summaries := []string{}
		for _, member := range members {
			if member.candidate.name != candidate.name {
				aliases = append(aliases, member.candidate.name)
			}
			aliases = append(aliases, member.candidate.aliases...)
			sourceChunkKeys = append(sourceChunkKeys, member.candidate.sourceChunkKeys...)
			if member.summary != "" {
				summaries = append(summaries, member.summary)
			}
		}
		candidate.aliases = dedupeStrings(aliases)
		candidate.sourceChunkKeys = dedupeStrings(sourceChunkKeys)
		summary := truncateRunes(strings.Join(dedupeStrings(summaries), "；"), 500)
		candidate.summary = firstNonEmpty(summary, candidate.summary)
		resolved = append(resolved, extractedItem{
			candidate: candidate,
			summary:   candidate.summary,
			contentMd: mergeResolvedKnowledgeContent(candidate.name, members),
		})
	}

	allRelations := append(append([]knowledgeRelation(nil), documentRelations...), plan.relations...)
	resolvedCandidates := make([]knowledgeCandidate, 0, len(resolved))
	for _, item := range resolved {
		resolvedCandidates = append(resolvedCandidates, item.candidate)
	}
	relations := remapKnowledgeRelations(allRelations, plan.canonicalByKey, resolvedCandidates, existing)
	for index := range resolved {
		pageKey := resolved[index].candidate.pageKey
		pageRelations := []knowledgeRelation{}
		related := []string{}
		for _, relation := range relations {
			if relation.fromPageKey != pageKey && relation.toPageKey != pageKey {
				continue
			}
			pageRelations = append(pageRelations, relation)
			if relation.fromPageKey == pageKey {
				related = append(related, relation.toPageKey)
			} else {
				related = append(related, relation.fromPageKey)
			}
		}
		resolved[index].relations = pageRelations
		resolved[index].relatedPageKeys = dedupeStrings(related)
	}
	return resolved, resolvedCandidates, relations, mergedCount
}

func mergeResolvedKnowledgeContent(title string, items []extractedItem) string {
	bodies := make([]string, 0, len(items))
	for _, item := range items {
		bodies = append(bodies, stripLeadingWikiTitle(item.contentMd, item.candidate.name))
	}
	return mergeKnowledgeMarkdownBodies(title, bodies...)
}

var regexpBlankLines = regexp.MustCompile(`\n{2,}`)

func mergeKnowledgeMarkdownBodies(title string, bodies ...string) string {
	blocks := []string{}
	seen := map[string]struct{}{}
	for _, body := range bodies {
		body = titleStripFirst.ReplaceAllString(trimSpace(body), "")
		for _, block := range regexpBlankLines.Split(body, -1) {
			block = trimSpace(block)
			key := strings.ToLower(spaceRe.ReplaceAllString(block, " "))
			if key == "" {
				continue
			}
			if _, duplicate := seen[key]; duplicate {
				continue
			}
			seen[key] = struct{}{}
			blocks = append(blocks, block)
		}
	}
	if len(blocks) == 0 {
		return "# " + title + "\n\n暂无详细说明。"
	}
	return "# " + title + "\n\n" + strings.Join(blocks, "\n\n")
}

// applyKnowledgeResolutionToExistingPages 在目录规划前隐藏即将并入 canonical 的旧页面。
func applyKnowledgeResolutionToExistingPages(
	pages []existingKnowledgePage,
	canonicalByKey map[string]string,
) []existingKnowledgePage {
	byKey := map[string]existingKnowledgePage{}
	order := []string{}
	for _, page := range pages {
		canonical := canonicalKnowledgePageKey(page.pageKey, canonicalByKey)
		if canonical != page.pageKey && !page.generated {
			canonical = page.pageKey
		}
		current, exists := byKey[canonical]
		if !exists {
			page.pageKey = canonical
			byKey[canonical] = page
			order = append(order, canonical)
			continue
		}
		if page.pageKey == canonical {
			// canonical 自身的标题、类型和目录优先；先前遇到的旧页只并入别名和来源。
			page.aliases = dedupeStrings(append(append(page.aliases, current.title), current.aliases...))
			page.sourceTitles = dedupeStrings(append(page.sourceTitles, current.sourceTitles...))
			page.sourceCount += current.sourceCount
			if len([]rune(current.summary)) > len([]rune(page.summary)) {
				page.summary = current.summary
			}
			byKey[canonical] = page
			continue
		}
		current.aliases = dedupeStrings(append(append(current.aliases, page.title), page.aliases...))
		current.sourceTitles = dedupeStrings(append(current.sourceTitles, page.sourceTitles...))
		current.sourceCount += page.sourceCount
		if len([]rune(page.summary)) > len([]rune(current.summary)) {
			current.summary = page.summary
		}
		byKey[canonical] = current
	}
	out := make([]existingKnowledgePage, 0, len(order))
	for _, key := range order {
		if page, exists := byKey[key]; exists {
			out = append(out, page)
			delete(byKey, key)
		}
	}
	return out
}
