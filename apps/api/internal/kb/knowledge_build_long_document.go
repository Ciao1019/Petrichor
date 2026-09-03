package kb

import (
	"context"
	"sort"
	"strings"
	"sync/atomic"
)

const (
	// 候选抽取按连续切片分段，确保长文档的每一部分都进入模型，而不是只保留头尾。
	knowledgeExtractionBatchMaxChars = 16_000
	knowledgeExtractionBatchMaxItems = 12
	wikiPageContextMaxChars          = 72_000
)

type documentCandidateBatch struct {
	summary    string
	candidates []knowledgeCandidate
	relations  []knowledgeRelation
	warnings   []string
}

func joinKnowledgeChunkContent(chunks []wfChunk) string {
	parts := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		if content := trimSpace(chunk.contentMd); content != "" {
			parts = append(parts, content)
		}
	}
	return strings.Join(parts, "\n\n")
}

func renderKnowledgeDocumentChunks(chunks []wfChunk) string {
	parts := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		parts = append(parts, strings.Join([]string{
			"<document_chunk id=\"" + chunk.chunkKey + "\">",
			"标题路径：" + renderHeadingTrail(chunk),
			chunk.contentMd,
			"</document_chunk>",
		}, "\n"))
	}
	return strings.Join(parts, "\n\n")
}

// attachKnowledgeCandidateSources 校验模型返回的来源切片。模型漏报时回落到当前分段，
// 这样页面物化至少能读取发现该候选时实际看过的正文，而不会再次退回文档头部。
func attachKnowledgeCandidateSources(candidates []knowledgeCandidate, parsed map[string]any, chunks []wfChunk) []knowledgeCandidate {
	validKeys := make(map[string]struct{}, len(chunks))
	fallbackKeys := make([]string, 0, len(chunks))
	for _, chunk := range chunks {
		validKeys[chunk.chunkKey] = struct{}{}
		fallbackKeys = append(fallbackKeys, chunk.chunkKey)
	}

	sourcesByPageKey := map[string][]string{}
	collect := func(values any, kind string) {
		list, ok := values.([]any)
		if !ok {
			return
		}
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
			for _, key := range normalizeStringList(entry["sourceChunkKeys"], -1) {
				if _, valid := validKeys[key]; valid {
					sourcesByPageKey[pageKey] = append(sourcesByPageKey[pageKey], key)
				}
			}
		}
	}
	collect(parsed["entities"], "entity")
	collect(parsed["concepts"], "concept")

	out := make([]knowledgeCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		keys := dedupeStrings(sourcesByPageKey[candidate.pageKey])
		if len(keys) == 0 {
			keys = append([]string(nil), fallbackKeys...)
		}
		candidate.sourceChunkKeys = keys
		out = append(out, candidate)
	}
	return out
}

// extractDocumentCandidates 对全部连续分段并行执行候选抽取，再做跨分段去重与全局收敛。
func extractDocumentCandidates(ctx context.Context, userID int64, profile compileProfile, articleTitle string, chunks []wfChunk, existingPages []existingKnowledgePage) (string, []knowledgeCandidate, []knowledgeRelation, []string) {
	batches := batchChunksByBudget(chunks, knowledgeExtractionBatchMaxChars, knowledgeExtractionBatchMaxItems)
	if len(batches) == 0 {
		return "", nil, nil, nil
	}

	var completed atomic.Int32
	outputs := mapWithConcurrency(batches, questionBatchConcurrency, func(batch []wfChunk) documentCandidateBatch {
		summary, candidates, relations, warnings := extractDocumentCandidateBatch(
			ctx, userID, profile, articleTitle, batch, existingPages,
		)
		done := int(completed.Add(1))
		reportKnowledgeBuildProgressNote(ctx, "正在分析长文档知识候选（"+jsonInt(done)+"/"+jsonInt(len(batches))+"）")
		return documentCandidateBatch{
			summary: summary, candidates: candidates, relations: relations, warnings: warnings,
		}
	})

	candidates, relations := mergeDocumentCandidateBatches(outputs, wikiItemLimit)
	summaries := make([]string, 0, len(outputs))
	warnings := []string{}
	for _, output := range outputs {
		if output.summary != "" {
			summaries = append(summaries, output.summary)
		}
		warnings = append(warnings, output.warnings...)
	}
	documentSummary, summaryWarning := combineKnowledgeDocumentSummaries(
		ctx, userID, profile, articleTitle, summaries,
	)
	if summaryWarning != "" {
		warnings = append(warnings, summaryWarning)
	}
	warnings = dedupeStrings(warnings)
	if len(warnings) > 8 {
		warnings = warnings[:8]
	}
	reportKnowledgeBuildProgress(ctx, 36, knowledgeBuildPhaseAnalyzing, "整篇知识候选分析完成", len(batches), len(batches))
	return documentSummary, candidates, relations, warnings
}

func mergeDocumentCandidateBatches(batches []documentCandidateBatch, limit int) ([]knowledgeCandidate, []knowledgeRelation) {
	mergedByKey := map[string]knowledgeCandidate{}
	batchKeys := make([][]string, len(batches))
	for batchIndex, batch := range batches {
		seenInBatch := map[string]struct{}{}
		for _, candidate := range batch.candidates {
			key := candidate.pageKey
			if existing, ok := mergedByKey[key]; ok {
				existing.aliases = dedupeStrings(append(existing.aliases, candidate.aliases...))
				if len(existing.aliases) > 12 {
					existing.aliases = existing.aliases[:12]
				}
				if len([]rune(candidate.summary)) > len([]rune(existing.summary)) {
					existing.summary = candidate.summary
				}
				existing.sourceChunkKeys = dedupeStrings(append(existing.sourceChunkKeys, candidate.sourceChunkKeys...))
				mergedByKey[key] = existing
			} else {
				candidate.aliases = dedupeStrings(candidate.aliases)
				candidate.sourceChunkKeys = dedupeStrings(candidate.sourceChunkKeys)
				mergedByKey[key] = candidate
			}
			if _, seen := seenInBatch[key]; !seen {
				seenInBatch[key] = struct{}{}
				batchKeys[batchIndex] = append(batchKeys[batchIndex], key)
			}
		}
	}

	capacity := limit
	if len(mergedByKey) < capacity {
		capacity = len(mergedByKey)
	}
	selected := make([]knowledgeCandidate, 0, capacity)
	selectedKeys := map[string]struct{}{}
	batchOrder := balancedKnowledgeBatchOrder(len(batchKeys))
	maxDepth := 0
	for _, keys := range batchKeys {
		if len(keys) > maxDepth {
			maxDepth = len(keys)
		}
	}
	for depth := 0; depth < maxDepth && len(selected) < limit; depth++ {
		for _, batchIndex := range batchOrder {
			if depth >= len(batchKeys[batchIndex]) {
				continue
			}
			key := batchKeys[batchIndex][depth]
			if _, exists := selectedKeys[key]; exists {
				continue
			}
			selectedKeys[key] = struct{}{}
			selected = append(selected, mergedByKey[key])
			if len(selected) >= limit {
				break
			}
		}
	}

	relations := make([]knowledgeRelation, 0)
	seenRelations := map[string]struct{}{}
	for _, batch := range batches {
		for _, relation := range batch.relations {
			if _, ok := selectedKeys[relation.fromPageKey]; !ok {
				continue
			}
			if _, ok := selectedKeys[relation.toPageKey]; !ok {
				continue
			}
			key := relation.fromPageKey + "|" + relation.toPageKey + "|" + relation.relationType
			if _, duplicate := seenRelations[key]; duplicate {
				continue
			}
			seenRelations[key] = struct{}{}
			relations = append(relations, relation)
			if len(relations) >= 160 {
				return selected, relations
			}
		}
	}
	return selected, relations
}

// balancedKnowledgeBatchOrder 让候选名额不足以覆盖全部分段时仍优先覆盖文档首尾与中部，
// 避免再次形成“只取前 N 段”的偏差。
func balancedKnowledgeBatchOrder(count int) []int {
	if count <= 0 {
		return nil
	}
	if count <= wikiItemLimit {
		order := make([]int, count)
		for index := range order {
			order[index] = index
		}
		return order
	}
	type interval struct{ left, right int }
	order := []int{0}
	if count > 1 {
		order = append(order, count-1)
	}
	queue := []interval{{0, count - 1}}
	seen := map[int]struct{}{0: {}, count - 1: {}}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if current.right-current.left <= 1 {
			continue
		}
		middle := (current.left + current.right) / 2
		if _, exists := seen[middle]; !exists {
			seen[middle] = struct{}{}
			order = append(order, middle)
		}
		queue = append(queue, interval{current.left, middle}, interval{middle, current.right})
	}
	return order
}

func combineKnowledgeDocumentSummaries(ctx context.Context, userID int64, profile compileProfile, articleTitle string, summaries []string) (string, string) {
	if len(summaries) == 0 {
		return "", ""
	}
	if len(summaries) == 1 {
		return summaries[0], ""
	}
	parts := make([]string, 0, len(summaries))
	for index, summary := range summaries {
		parts = append(parts, "<segment_summary index=\""+jsonInt(index+1)+"\">"+summary+"</segment_summary>")
	}
	parsed, err := invokeKnowledgeBuildJSON(ctx, ChatRequest{
		UserID: userID,
		SystemPrompt: profile.systemPrompt(
			"你是长文档摘要合并器。根据按原文顺序排列的全部分段摘要，生成一段覆盖整篇文档的独立摘要。",
			"兼顾开头、中部和结尾的重要主题，不要只复述前几个分段。只输出 JSON：{\"documentSummary\":\"...\"}。",
		),
		Message: "文档标题：" + articleTitle + "\n\n" + strings.Join(parts, "\n"),
		Op:      "kb.build.summary",
	})
	if err == nil {
		if summary := truncateRunes(trimSpace(optString(parsed["documentSummary"])), 800); summary != "" {
			return summary, ""
		}
		err = errKnowledgeBuildInvalidJSON
	}
	return balancedLocalDocumentSummary(summaries, 800), knowledgeBuildFallbackWarning(
		"长文档摘要合并", "已使用分段摘要", err,
	)
}

func balancedLocalDocumentSummary(summaries []string, maxChars int) string {
	if len(summaries) == 0 || maxChars <= 0 {
		return ""
	}
	separator := "；"
	budget := maxChars - len([]rune(separator))*(len(summaries)-1)
	if budget < len(summaries) {
		budget = maxChars
		separator = ""
	}
	perSegment := budget / len(summaries)
	if perSegment < 1 {
		perSegment = 1
	}
	parts := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		parts = append(parts, truncateRunes(trimSpace(summary), perSegment))
	}
	return truncateRunes(strings.Join(parts, separator), maxChars)
}

func candidateSourceKeys(candidate knowledgeCandidate, chunks []wfChunk) []string {
	valid := make(map[string]struct{}, len(chunks))
	for _, chunk := range chunks {
		valid[chunk.chunkKey] = struct{}{}
	}
	keys := make([]string, 0, len(candidate.sourceChunkKeys))
	for _, key := range candidate.sourceChunkKeys {
		if _, ok := valid[key]; ok {
			keys = append(keys, key)
		}
	}
	if len(keys) > 0 {
		return dedupeStrings(keys)
	}
	for _, chunk := range chunks {
		keys = append(keys, chunk.chunkKey)
	}
	return keys
}

func batchKnowledgeCandidatesByContext(candidates []knowledgeCandidate, chunks []wfChunk) [][]knowledgeCandidate {
	sizeByKey := make(map[string]int, len(chunks))
	for _, chunk := range chunks {
		sizeByKey[chunk.chunkKey] = len([]rune(chunk.contentMd))
	}
	type contextBatch struct {
		candidates []knowledgeCandidate
		keys       map[string]struct{}
		chars      int
	}
	batches := []contextBatch{}
	for _, candidate := range candidates {
		keys := candidateSourceKeys(candidate, chunks)
		bestIndex := -1
		bestAddedChars := 0
		for index := range batches {
			if len(batches[index].candidates) >= wikiPageBatchSize {
				continue
			}
			addedChars := 0
			for _, key := range keys {
				if _, exists := batches[index].keys[key]; !exists {
					addedChars += sizeByKey[key]
				}
			}
			if batches[index].chars+addedChars > wikiPageContextMaxChars {
				continue
			}
			if bestIndex < 0 || addedChars < bestAddedChars {
				bestIndex = index
				bestAddedChars = addedChars
			}
		}
		if bestIndex < 0 {
			keySet := map[string]struct{}{}
			chars := 0
			for _, key := range keys {
				keySet[key] = struct{}{}
				chars += sizeByKey[key]
			}
			batches = append(batches, contextBatch{
				candidates: []knowledgeCandidate{candidate}, keys: keySet, chars: chars,
			})
			continue
		}
		batches[bestIndex].candidates = append(batches[bestIndex].candidates, candidate)
		for _, key := range keys {
			if _, exists := batches[bestIndex].keys[key]; exists {
				continue
			}
			batches[bestIndex].keys[key] = struct{}{}
			batches[bestIndex].chars += sizeByKey[key]
		}
	}
	out := make([][]knowledgeCandidate, 0, len(batches))
	for _, batch := range batches {
		out = append(out, batch.candidates)
	}
	return out
}

func buildKnowledgeCandidateContext(candidates []knowledgeCandidate, chunks []wfChunk) string {
	selected := map[string]struct{}{}
	for _, candidate := range candidates {
		for _, key := range candidateSourceKeys(candidate, chunks) {
			selected[key] = struct{}{}
		}
	}
	contextChunks := make([]wfChunk, 0, len(selected))
	for _, chunk := range chunks {
		if _, ok := selected[chunk.chunkKey]; ok {
			contextChunks = append(contextChunks, chunk)
		}
	}
	sort.SliceStable(contextChunks, func(left, right int) bool {
		return contextChunks[left].position < contextChunks[right].position
	})
	return renderKnowledgeDocumentChunks(contextChunks)
}
