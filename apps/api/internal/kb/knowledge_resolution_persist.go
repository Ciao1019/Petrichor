package kb

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"
)

func nonIdentityKnowledgeMappings(canonicalByKey map[string]string) map[string]string {
	result := map[string]string{}
	for pageKey, canonical := range canonicalByKey {
		canonical = canonicalKnowledgePageKey(canonical, canonicalByKey)
		if canonical != "" && canonical != pageKey {
			result[pageKey] = canonical
		}
	}
	return result
}

// consolidateResolvedKnowledgePages 把 AI 判定为同一知识的存量生成页合入 canonical。
// 手写页面只能作为 canonical，永远不会作为自动删除的来源页。
func consolidateResolvedKnowledgePages(
	ctx context.Context,
	q execQuerier,
	userID, knowledgeBaseID int64,
	canonicalByKey map[string]string,
	now time.Time,
) error {
	mappings := nonIdentityKnowledgeMappings(canonicalByKey)
	if len(mappings) == 0 {
		return nil
	}
	pages, err := queryWikiPagesWhere(ctx, q,
		`user_id = $1 AND knowledge_base_id = $2 AND kind IN ('entity','concept') AND archived_at IS NULL`,
		userID, knowledgeBaseID)
	if err != nil {
		return err
	}
	byKey := make(map[string]*WikiPageRow, len(pages))
	for index := range pages {
		byKey[pages[index].PageKey] = &pages[index]
	}
	groups := map[string][]*WikiPageRow{}
	for sourceKey, canonical := range mappings {
		source, target := byKey[sourceKey], byKey[canonical]
		if source == nil || target == nil || source.ID == target.ID || source.Kind != target.Kind {
			continue
		}
		sourceMetadata := readKnowledgePageMetadata(source.FrontmatterJson)
		if optString(sourceMetadata["generatedBy"]) != "article-knowledge-build" {
			continue
		}
		groups[canonical] = append(groups[canonical], source)
	}
	if len(groups) == 0 {
		return nil
	}

	deletedRefs := []wikiPageRef{}
	appliedMappings := map[string]string{}
	for _, canonical := range sortedKnowledgeMergeGroupKeys(groups) {
		target := byKey[canonical]
		if target == nil {
			continue
		}
		metadata := mergeableKnowledgePageMetadata(target)
		for _, source := range groups[canonical] {
			metadata = mergeKnowledgePageMetadata(target.Title, metadata, source)
			deletedRefs = append(deletedRefs, wikiPageRef{ID: source.ID, PageKey: source.PageKey})
			appliedMappings[source.PageKey] = canonical
		}
		contributions, _ := metadata["contributions"].(map[string]any)
		refInputs := knowledgeContributionSourceRefs(contributions)
		summary := firstKnowledgeContributionSummary(metadata, derefStr(target.Summary))
		updated, upsertErr := upsertWikiPage(ctx, q, upsertWikiPageInput{
			UserID: userID, KnowledgeBaseID: knowledgeBaseID,
			PageKey: target.PageKey, Title: target.Title, Kind: target.Kind,
			ContentMd: renderAggregatedKnowledgePage(target.Title, metadata),
			Summary:   strPtr(summary), Frontmatter: metadata, HasFrontmatter: true,
			SourceRefs: refInputs, Now: now,
		})
		if upsertErr != nil {
			return upsertErr
		}
		byKey[canonical] = updated
	}
	if err := rewriteWikiPageKeyReferences(ctx, q, userID, knowledgeBaseID, appliedMappings, now); err != nil {
		return err
	}
	_, err = deleteWikiPagesCascade(ctx, q, userID, knowledgeBaseID, deletedRefs)
	return err
}

func sortedKnowledgeMergeGroupKeys(groups map[string][]*WikiPageRow) []string {
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
		sort.Slice(groups[key], func(left, right int) bool {
			return groups[key][left].PageKey < groups[key][right].PageKey
		})
	}
	sort.Strings(keys)
	return keys
}

func mergeableKnowledgePageMetadata(page *WikiPageRow) map[string]any {
	metadata := readKnowledgePageMetadata(page.FrontmatterJson)
	raw := parseJSONObject(page.FrontmatterJson)
	for key, value := range raw {
		if _, known := metadata[key]; !known {
			metadata[key] = value
		}
	}
	if optString(metadata["generatedBy"]) != "article-knowledge-build" {
		metadata["baseContentMd"] = page.ContentMd
		metadata["baseSummary"] = derefStr(page.Summary)
		metadata["contributions"] = map[string]any{}
	}
	metadata["generatedBy"] = "article-knowledge-build"
	metadata["buildVersion"] = ArticleKnowledgeBuildVersion
	return metadata
}

func mergeKnowledgePageMetadata(title string, target map[string]any, source *WikiPageRow) map[string]any {
	sourceMetadata := readKnowledgePageMetadata(source.FrontmatterJson)
	targetAliases := toStrSlice(target["aliases"])
	targetAliases = append(targetAliases, source.Title)
	target["aliases"] = dedupeStrings(append(targetAliases, toStrSlice(sourceMetadata["aliases"])...))

	if len(toStrSlice(target["categoryPath"])) == 0 {
		target["categoryPath"] = toStrSlice(sourceMetadata["categoryPath"])
		target["taxonomyVersion"] = sourceMetadata["taxonomyVersion"]
	}
	targetBase := optString(target["baseContentMd"])
	sourceBase := optString(sourceMetadata["baseContentMd"])
	if sourceBase != "" {
		target["baseContentMd"] = mergeKnowledgeMarkdownBodies(title, targetBase, sourceBase)
	}
	target["baseSummary"] = mergeKnowledgeSummaries(
		optString(target["baseSummary"]), optString(sourceMetadata["baseSummary"]),
	)

	targetContributions, _ := target["contributions"].(map[string]any)
	if targetContributions == nil {
		targetContributions = map[string]any{}
	}
	sourceContributions, _ := sourceMetadata["contributions"].(map[string]any)
	for articleID, sourceEntry := range sourceContributions {
		if targetEntry, exists := targetContributions[articleID]; exists {
			targetContributions[articleID] = mergeKnowledgeContribution(title, targetEntry, sourceEntry)
		} else {
			targetContributions[articleID] = sourceEntry
		}
	}
	target["contributions"] = targetContributions
	return target
}

func mergeKnowledgeContribution(title string, leftValue, rightValue any) map[string]any {
	left, _ := leftValue.(map[string]any)
	right, _ := rightValue.(map[string]any)
	result := map[string]any{}
	for key, value := range right {
		result[key] = value
	}
	for key, value := range left {
		result[key] = value
	}
	result["summary"] = mergeKnowledgeSummaries(optString(left["summary"]), optString(right["summary"]))
	result["contentMd"] = mergeKnowledgeMarkdownBodies(title,
		optString(left["contentMd"]), optString(right["contentMd"]))
	result["aliases"] = dedupeStrings(append(toStrSlice(left["aliases"]), toStrSlice(right["aliases"])...))
	result["sourceChunkKeys"] = dedupeStrings(append(
		toStrSlice(left["sourceChunkKeys"]), toStrSlice(right["sourceChunkKeys"])...,
	))
	result["relatedPageKeys"] = dedupeStrings(append(
		toStrSlice(left["relatedPageKeys"]), toStrSlice(right["relatedPageKeys"])...,
	))
	result["relations"] = mergeStoredKnowledgeRelations(left["relations"], right["relations"])
	return result
}

func mergeKnowledgeSummaries(values ...string) string {
	cleaned := []string{}
	for _, value := range values {
		if value = trimSpace(value); value != "" {
			cleaned = append(cleaned, value)
		}
	}
	return truncateRunes(strings.Join(dedupeStrings(cleaned), "；"), 500)
}

func mergeStoredKnowledgeRelations(values ...any) []map[string]string {
	raw := []any{}
	for _, value := range values {
		switch typed := value.(type) {
		case []map[string]string:
			for _, relation := range typed {
				raw = append(raw, map[string]any{
					"fromPageKey": relation["fromPageKey"], "toPageKey": relation["toPageKey"],
					"relationType": relation["relationType"], "description": relation["description"],
				})
			}
		case []any:
			raw = append(raw, typed...)
		}
	}
	return normalizeStoredKnowledgeRelations(raw)
}

func knowledgeContributionSourceRefs(contributions map[string]any) []sourceRefInput {
	refs := make([]sourceRefInput, 0, len(contributions))
	for _, articleID := range sortedKeys(contributions) {
		id, err := strconv.ParseInt(articleID, 10, 64)
		if err != nil {
			continue
		}
		title := "文章 " + articleID
		if entry, ok := contributions[articleID].(map[string]any); ok {
			title = firstNonEmpty(optString(entry["articleTitle"]), title)
		}
		note := "构建知识：" + title
		refs = append(refs, sourceRefInput{ArticleID: id, Note: &note})
	}
	return refs
}

func firstKnowledgeContributionSummary(metadata map[string]any, fallback string) string {
	if summary := optString(metadata["baseSummary"]); summary != "" {
		return summary
	}
	contributions, _ := metadata["contributions"].(map[string]any)
	for _, articleID := range sortedKeys(contributions) {
		if entry, ok := contributions[articleID].(map[string]any); ok {
			if summary := optString(entry["summary"]); summary != "" {
				return summary
			}
		}
	}
	return fallback
}

func rewriteKnowledgeFrontmatterPageKeys(metadata map[string]any, mappings map[string]string) bool {
	if metadata == nil || len(mappings) == 0 {
		return false
	}
	changed := false
	contributions, _ := metadata["contributions"].(map[string]any)
	for articleID, rawEntry := range contributions {
		entry, ok := rawEntry.(map[string]any)
		if !ok {
			continue
		}
		if content := optString(entry["contentMd"]); content != "" {
			rewritten := rewriteKnowledgeContentPageKeys(content, mappings)
			if rewritten != content {
				entry["contentMd"] = rewritten
				changed = true
			}
		}
		related := toStrSlice(entry["relatedPageKeys"])
		for index, pageKey := range related {
			canonical := canonicalKnowledgePageKey(pageKey, mappings)
			if canonical != pageKey {
				related[index] = canonical
				changed = true
			}
		}
		entry["relatedPageKeys"] = dedupeStrings(related)
		relations := mergeStoredKnowledgeRelations(entry["relations"])
		for index := range relations {
			from := canonicalKnowledgePageKey(relations[index]["fromPageKey"], mappings)
			to := canonicalKnowledgePageKey(relations[index]["toPageKey"], mappings)
			if from != relations[index]["fromPageKey"] || to != relations[index]["toPageKey"] {
				changed = true
			}
			relations[index]["fromPageKey"] = from
			relations[index]["toPageKey"] = to
		}
		entry["relations"] = normalizeStoredKnowledgeRelations(storedRelationMapsToAny(relations))
		contributions[articleID] = entry
	}
	metadata["contributions"] = contributions
	return changed
}

func storedRelationMapsToAny(relations []map[string]string) []any {
	values := make([]any, 0, len(relations))
	for _, relation := range relations {
		values = append(values, map[string]any{
			"fromPageKey": relation["fromPageKey"], "toPageKey": relation["toPageKey"],
			"relationType": relation["relationType"], "description": relation["description"],
		})
	}
	return values
}

func rewriteKnowledgeContentPageKeys(content string, mappings map[string]string) string {
	keys := make([]string, 0, len(mappings))
	for oldKey := range mappings {
		keys = append(keys, oldKey)
	}
	sort.Slice(keys, func(left, right int) bool {
		if len(keys[left]) != len(keys[right]) {
			return len(keys[left]) > len(keys[right])
		}
		return keys[left] < keys[right]
	})
	for _, oldKey := range keys {
		canonical := canonicalKnowledgePageKey(oldKey, mappings)
		if canonical == "" || canonical == oldKey {
			continue
		}
		content = strings.ReplaceAll(content, "[["+oldKey+"|", "[["+canonical+"|")
		content = strings.ReplaceAll(content, "[["+oldKey+"]]", "[["+canonical+"]]")
		content = strings.ReplaceAll(content, "[["+oldKey+"#", "[["+canonical+"#")
	}
	return content
}
