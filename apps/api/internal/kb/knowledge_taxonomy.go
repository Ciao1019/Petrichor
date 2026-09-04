package kb

import (
	"context"
	"regexp"
	"slices"
	"sort"
	"strings"
)

const (
	// ArticleKnowledgeTaxonomyVersion 独立于正文编译版本：目录算法升级时只重整分类，
	// 不把页面正文误标成过期，也不会永久沿用旧算法生成的“按文件分组”目录。
	ArticleKnowledgeTaxonomyVersion = 1
	knowledgeTaxonomyPlanBatchSize  = 40
	knowledgeTaxonomyFallbackLabel  = "待整理"
)

func knowledgeTaxonomyStageOutcome(warnings []string) (string, string) {
	if len(warnings) > 0 {
		return knowledgeBuildStageFailed, "全局知识目录规划未完成，已保留旧目录或归入待整理"
	}
	return knowledgeBuildStageCompleted, "全局知识目录规划完成"
}

func knowledgeTaxonomyStageUpdate(warnings []string) knowledgeBuildStageUpdate {
	status, message := knowledgeTaxonomyStageOutcome(warnings)
	return knowledgeBuildStageUpdate{
		ParentID: knowledgeBuildPhaseTaxonomy,
		ID:       knowledgeBuildStageCatalog, Status: status,
		Message: message, Percent: 100,
	}
}

type knowledgeTaxonomyItem struct {
	candidate    knowledgeCandidate
	sourceTitles []string
}

func loadExistingKnowledgePages(ctx context.Context, q execQuerier, userID, knowledgeBaseID int64) ([]existingKnowledgePage, error) {
	rows, err := queryWikiPagesWhere(ctx, q,
		`user_id = $1 AND knowledge_base_id = $2 AND kind IN ('entity','concept') AND archived_at IS NULL`,
		userID, knowledgeBaseID)
	if err != nil {
		return nil, err
	}
	pages := make([]existingKnowledgePage, 0, len(rows))
	for i := range rows {
		page := &rows[i]
		metadata := readKnowledgePageMetadata(page.FrontmatterJson)
		kind := "entity"
		if page.Kind == "concept" {
			kind = "concept"
		}
		sourceTitles := []string{}
		sourceCount := 0
		if contributions, ok := metadata["contributions"].(map[string]any); ok {
			sourceCount = len(contributions)
			for _, articleID := range sortedKeys(contributions) {
				entry, _ := contributions[articleID].(map[string]any)
				if title := trimSpace(optString(entry["articleTitle"])); title != "" {
					sourceTitles = append(sourceTitles, title)
				}
			}
		}
		pages = append(pages, existingKnowledgePage{
			pageKey:         page.PageKey,
			title:           page.Title,
			kind:            kind,
			aliases:         toStrSlice(metadata["aliases"]),
			summary:         derefStr(page.Summary),
			categoryPath:    toStrSlice(metadata["categoryPath"]),
			taxonomyVersion: int64(optNumber(metadata["taxonomyVersion"])),
			generated:       optString(metadata["generatedBy"]) == "article-knowledge-build",
			sourceTitles:    dedupeStrings(sourceTitles),
			sourceCount:     sourceCount,
		})
	}
	return pages, nil
}

func applyKnowledgeTaxonomyToItems(items []extractedItem, candidates []knowledgeCandidate) []extractedItem {
	byKey := make(map[string]knowledgeCandidate, len(candidates))
	for _, candidate := range candidates {
		byKey[candidate.pageKey] = candidate
	}
	for index := range items {
		if candidate, exists := byKey[items[index].candidate.pageKey]; exists {
			items[index].candidate = candidate
		}
	}
	return items
}

// planKnowledgeTaxonomy 在同一知识库的全局页面集合上规划目录，而不是只看当前文件。
// 返回的 existingUpdates 只包含本次未重建、但目录版本已经过期的存量生成页。
func planKnowledgeTaxonomy(
	ctx context.Context,
	userID int64,
	profile compileProfile,
	articleTitle string,
	candidates []knowledgeCandidate,
	existingPages []existingKnowledgePage,
) ([]knowledgeCandidate, map[string][]string, []string) {
	if len(candidates) == 0 && len(existingPages) == 0 {
		return candidates, nil, nil
	}

	stableByKey := map[string][]string{}
	previousByKey := map[string]existingKnowledgePage{}
	pendingByKey := map[string]knowledgeTaxonomyItem{}
	stablePaths := make([][]string, 0)
	for _, page := range existingPages {
		previousByKey[page.pageKey] = page
		path := normalizeKnowledgeCategoryPath(page.categoryPath)
		stable := len(path) > 0 && !isKnowledgeTaxonomyFallbackPath(path) &&
			(!page.generated || page.taxonomyVersion >= ArticleKnowledgeTaxonomyVersion)
		if stable {
			stableByKey[page.pageKey] = path
			stablePaths = append(stablePaths, path)
			continue
		}
		// 手写页面没有目录时保持在根级；只自动重整编译生成的页面。
		if !page.generated {
			continue
		}
		pendingByKey[page.pageKey] = knowledgeTaxonomyItem{
			candidate: knowledgeCandidate{
				kind: page.kind, name: page.title, pageKey: page.pageKey,
				aliases: page.aliases, summary: page.summary,
			},
			sourceTitles: append([]string(nil), page.sourceTitles...),
		}
	}

	currentKeys := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		currentKeys[candidate.pageKey] = struct{}{}
		if path := stableByKey[candidate.pageKey]; len(path) > 0 {
			continue
		}
		sourceTitles := []string{articleTitle}
		if previous, exists := previousByKey[candidate.pageKey]; exists {
			sourceTitles = append(sourceTitles, previous.sourceTitles...)
		}
		pendingByKey[candidate.pageKey] = knowledgeTaxonomyItem{
			candidate:    candidate,
			sourceTitles: dedupeStrings(sourceTitles),
		}
	}

	pending := make([]knowledgeTaxonomyItem, 0, len(pendingByKey))
	for _, item := range pendingByKey {
		pending = append(pending, item)
	}
	pending = balanceKnowledgeTaxonomyItems(pending)
	planned, warnings := planKnowledgeTaxonomyItems(ctx, userID, profile, pending, stablePaths)

	out := make([]knowledgeCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if path := stableByKey[candidate.pageKey]; len(path) > 0 {
			candidate.categoryPath = append([]string(nil), path...)
			candidate.taxonomyVersion = ArticleKnowledgeTaxonomyVersion
		} else if path := planned[candidate.pageKey]; len(path) > 0 {
			candidate.categoryPath = append([]string(nil), path...)
			candidate.taxonomyVersion = ArticleKnowledgeTaxonomyVersion
		} else if previous, exists := previousByKey[candidate.pageKey]; exists && len(previous.categoryPath) > 0 {
			// 模型降级时宁可暂时保留旧目录，也不把已存在的页面搬到空目录。
			candidate.categoryPath = append([]string(nil), previous.categoryPath...)
			candidate.taxonomyVersion = previous.taxonomyVersion
		} else {
			candidate.categoryPath = []string{knowledgeTaxonomyFallbackLabel}
		}
		out = append(out, candidate)
	}

	existingUpdates := map[string][]string{}
	for pageKey, path := range planned {
		if _, rebuiltNow := currentKeys[pageKey]; rebuiltNow {
			continue
		}
		existingUpdates[pageKey] = path
	}
	if len(warnings) > 8 {
		warnings = warnings[:8]
	}
	return out, existingUpdates, warnings
}

func planKnowledgeTaxonomyItems(
	ctx context.Context,
	userID int64,
	profile compileProfile,
	items []knowledgeTaxonomyItem,
	existingPaths [][]string,
) (map[string][]string, []string) {
	result := make(map[string][]string, len(items))
	warnings := []string{}
	for start := 0; start < len(items); start += knowledgeTaxonomyPlanBatchSize {
		end := min(start+knowledgeTaxonomyPlanBatchSize, len(items))
		batch := items[start:end]
		foldersText := formatKnowledgeTaxonomyTree(existingPaths)
		if foldersText == "" {
			foldersText = "（当前知识库还没有可复用目录，请设计一棵新的统一目录树）"
		}
		var itemsText strings.Builder
		for _, item := range batch {
			itemsText.WriteString("- pageKey: ")
			itemsText.WriteString(item.candidate.pageKey)
			itemsText.WriteString(" | type: ")
			itemsText.WriteString(item.candidate.kind)
			itemsText.WriteString(" | title: ")
			itemsText.WriteString(item.candidate.name)
			if item.candidate.summary != "" {
				itemsText.WriteString(" | about: ")
				itemsText.WriteString(truncateRunes(item.candidate.summary, 180))
			}
			itemsText.WriteByte('\n')
		}

		parsed, err := invokeKnowledgeBuildJSON(ctx, ChatRequest{
			UserID: userID,
			SystemPrompt: profile.systemPrompt(
				"你是 Wiki 全局导航目录规划器。请按知识对象本身的稳定语义，为整批页面规划一棵跨文档共享的中文目录树。",
				"目录回答‘它本质上是什么/属于哪个长期主题’，绝不能回答‘它在某篇文件里处于哪一章’。输入刻意不提供源文件名，不得按文件、产品手册或文章主题各建一棵子树。",
				"来自同一文件的页面要按语义拆到合适的公共目录；来自不同文件但性质相同的页面必须复用同一目录。",
				"优先逐字复用 existing_folders。没有合适目录时才能创建宽泛、持久的语义目录，例如‘软件与工具’‘平台与环境’‘技术与协议’‘方法与机制’。",
				"禁止使用‘核心功能’‘配置指南’‘安装部署’‘命令行用法’‘常见问题’‘使用须知’等文档章节或操作阶段作为目录。",
				"entity/concept 只是页面类型元数据，绝不能建立‘实体’‘概念’目录。每条路径最多 2 级，优先 1 级；一级目录通常不超过 6 个，二级目录必须能被多个页面复用。",
				"目录数量必须显著少于页面数量；禁止一页一目录，禁止把页面标题原样建成叶子目录。每个 pageKey 必须恰好返回一次。",
				"只输出 JSON，不要 Markdown 围栏：{\"assignments\":[{\"pageKey\":\"entity-example\",\"path\":[\"软件与工具\",\"系统工具\"]}]}。",
			),
			Message: strings.Join([]string{
				"<existing_folders>", foldersText, "</existing_folders>",
				"<requested_items>", itemsText.String(), "</requested_items>",
			}, "\n\n"),
			Op:        "kb.build.taxonomy",
			MaxTokens: 8_192,
		})
		if err != nil {
			warnings = append(warnings, knowledgeBuildFallbackWarning(
				"知识目录规划", "本批页面暂时保留旧目录或归入待整理", err,
			))
			continue
		}

		assignments, ok := parsed["assignments"].([]any)
		if !ok {
			warnings = append(warnings, "知识目录规划结果缺少 assignments，本批页面暂时保留旧目录或归入待整理")
			continue
		}
		aliases := knowledgeTaxonomyKeyAliases(batch)
		batchResult := map[string][]string{}
		for _, raw := range assignments {
			entry, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			rawKey := firstNonEmpty(
				trimSpace(optString(entry["pageKey"])),
				trimSpace(optString(entry["key"])),
				trimSpace(optString(entry["slug"])),
			)
			pageKey := aliases[knowledgeTaxonomyAlias(rawKey)]
			if pageKey == "" {
				continue
			}
			pathValue := entry["path"]
			if pathValue == nil {
				pathValue = entry["categoryPath"]
			}
			path := normalizeKnowledgeCategoryPath(pathValue)
			item := taxonomyItemByPageKey(batch, pageKey)
			if len(path) == 0 || item == nil || !validKnowledgeTaxonomyPath(*item, batch, path) {
				continue
			}
			if _, duplicate := batchResult[pageKey]; duplicate {
				continue
			}
			batchResult[pageKey] = path
		}
		if !validKnowledgeTaxonomyShape(batchResult) {
			warnings = append(warnings, "知识目录规划结果仍是一页一目录，本批页面暂时保留旧目录或归入待整理")
			continue
		}
		for pageKey, path := range batchResult {
			result[pageKey] = path
			existingPaths = append(existingPaths, path)
		}
		if missing := len(batch) - len(batchResult); missing > 0 {
			warnings = append(warnings, jsonInt(missing)+" 个页面的目录结果无效，已暂时保留旧目录或归入待整理")
		}
	}
	return result, dedupeStrings(warnings)
}

func taxonomyItemByPageKey(items []knowledgeTaxonomyItem, pageKey string) *knowledgeTaxonomyItem {
	for i := range items {
		if items[i].candidate.pageKey == pageKey {
			return &items[i]
		}
	}
	return nil
}

// balanceKnowledgeTaxonomyItems 按来源轮询页面，避免大知识库的首批恰好全来自同一文件。
// 来源名只用于本地排序和结果校验，绝不会发送给模型。
func balanceKnowledgeTaxonomyItems(items []knowledgeTaxonomyItem) []knowledgeTaxonomyItem {
	groups := map[string][]knowledgeTaxonomyItem{}
	for _, item := range items {
		key := "\uffff"
		if len(item.sourceTitles) > 0 {
			titles := append([]string(nil), item.sourceTitles...)
			sort.Strings(titles)
			key = titles[0]
		}
		groups[key] = append(groups[key], item)
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
		sort.Slice(groups[key], func(i, j int) bool {
			return groups[key][i].candidate.pageKey < groups[key][j].candidate.pageKey
		})
	}
	sort.Strings(keys)
	out := make([]knowledgeTaxonomyItem, 0, len(items))
	for {
		added := false
		for _, key := range keys {
			if len(groups[key]) == 0 {
				continue
			}
			out = append(out, groups[key][0])
			groups[key] = groups[key][1:]
			added = true
		}
		if !added {
			return out
		}
	}
}

func knowledgeTaxonomyKeyAliases(items []knowledgeTaxonomyItem) map[string]string {
	aliases := make(map[string]string, len(items)*3)
	add := func(alias, pageKey string) {
		alias = knowledgeTaxonomyAlias(alias)
		if alias == "" {
			return
		}
		if current, exists := aliases[alias]; exists && current != pageKey {
			aliases[alias] = ""
			return
		}
		aliases[alias] = pageKey
	}
	for _, item := range items {
		pageKey := item.candidate.pageKey
		add(pageKey, pageKey)
		add(strings.TrimPrefix(strings.TrimPrefix(pageKey, "entity-"), "concept-"), pageKey)
		add(item.candidate.name, pageKey)
	}
	return aliases
}

var knowledgeTaxonomyAliasCleaner = regexp.MustCompile(`[\s/／|｜:_-]+`)

func knowledgeTaxonomyAlias(value string) string {
	return knowledgeTaxonomyAliasCleaner.ReplaceAllString(strings.ToLower(trimSpace(value)), "")
}

func validKnowledgeTaxonomyPath(item knowledgeTaxonomyItem, peers []knowledgeTaxonomyItem, path []string) bool {
	for _, label := range path {
		if isKnowledgeTaxonomyRoleLabel(label) {
			return false
		}
		labelKey := knowledgeTaxonomyComparable(label)
		if labelKey == knowledgeTaxonomyComparable(item.candidate.name) ||
			labelKey == knowledgeTaxonomyComparable(item.candidate.pageKey) {
			return false
		}
		for _, sourceTitle := range item.sourceTitles {
			for _, variant := range knowledgeSourceTitleVariants(sourceTitle) {
				variantKey := knowledgeTaxonomyComparable(variant)
				if taxonomyLabelContainsName(labelKey, variantKey) {
					return false
				}
			}
		}
		// 文件标题和产品名可能不同（例如“小鼹鼠”文档里的 Mole）。同来源的具名实体
		// 也不能成为其他页面的目录，否则仍会退化成一份产品文档一棵子树。
		for _, peer := range peers {
			if peer.candidate.kind != "entity" || !knowledgeTaxonomySourcesOverlap(item.sourceTitles, peer.sourceTitles) {
				continue
			}
			if taxonomyLabelContainsName(labelKey, knowledgeTaxonomyComparable(peer.candidate.name)) {
				return false
			}
		}
	}
	return true
}

func taxonomyLabelContainsName(labelKey, nameKey string) bool {
	return len([]rune(nameKey)) >= 3 && (strings.Contains(labelKey, nameKey) || strings.Contains(nameKey, labelKey))
}

func knowledgeTaxonomySourcesOverlap(left, right []string) bool {
	for _, leftTitle := range left {
		for _, rightTitle := range right {
			if leftTitle != "" && leftTitle == rightTitle {
				return true
			}
		}
	}
	return false
}

func validKnowledgeTaxonomyShape(assignments map[string][]string) bool {
	if len(assignments) < 4 {
		return true
	}
	paths := map[string]struct{}{}
	topLevels := map[string]struct{}{}
	for _, path := range assignments {
		if len(path) == 0 {
			continue
		}
		paths[strings.Join(path, "\x00")] = struct{}{}
		topLevels[path[0]] = struct{}{}
	}
	maxPaths := (len(assignments)*2 + 2) / 3
	return len(paths) <= maxPaths && len(topLevels) <= 6
}

var knowledgeTaxonomyRoleLabels = map[string]struct{}{
	"核心功能": {}, "主要功能": {}, "功能介绍": {}, "功能特性": {},
	"配置指南": {}, "配置说明": {}, "使用指南": {}, "使用说明": {}, "操作指南": {},
	"安装部署": {}, "安装指南": {}, "快速开始": {}, "入门指南": {},
	"命令行用法": {}, "使用须知": {}, "常见问题": {}, "问题排查": {}, "故障排除": {},
	"最佳实践": {}, "进阶使用": {}, "文档章节": {},
}

func isKnowledgeTaxonomyRoleLabel(label string) bool {
	_, exists := knowledgeTaxonomyRoleLabels[strings.TrimSpace(label)]
	return exists
}

var knowledgeTaxonomyComparableCleaner = regexp.MustCompile(`[\s\p{P}\p{S}]+`)

func knowledgeTaxonomyComparable(value string) string {
	return knowledgeTaxonomyComparableCleaner.ReplaceAllString(strings.ToLower(trimSpace(value)), "")
}

var sourceTitleSuffixes = []string{
	"使用说明", "用户手册", "操作手册", "开发手册", "参考手册", "使用手册",
	"快速指南", "入门指南", "配置指南", "安装指南", "说明文档", "技术文档",
	"文档", "手册", "指南", "教程", "说明", "readme",
}

func knowledgeSourceTitleVariants(title string) []string {
	value := trimSpace(regexp.MustCompile(`(?i)\.(md|mdx|txt|pdf|docx?)$`).ReplaceAllString(title, ""))
	if value == "" {
		return nil
	}
	variants := []string{value}
	lowered := strings.ToLower(value)
	for _, suffix := range sourceTitleSuffixes {
		if strings.HasSuffix(lowered, strings.ToLower(suffix)) {
			stem := trimSpace(value[:len(value)-len(suffix)])
			stem = strings.TrimRight(stem, "-—_：:· ")
			if stem != "" {
				variants = append(variants, stem)
			}
		}
	}
	return dedupeStrings(variants)
}

var knowledgeCategorySeparatorRe = regexp.MustCompile(`[/／|｜>]`)
var knowledgeCategoryBannedRe = regexp.MustCompile(`(?i)^(实体|實體|概念|entity|entities|concept|concepts|summary|index|wiki|页面|頁面)$`)

// normalizeKnowledgeCategoryPath 接受数据库中的 []string 与模型 JSON 的 []any/string，
// 清洗为最多两级路径。旧实现漏掉 []string，导致存量目录每次都被当成不存在。
func normalizeKnowledgeCategoryPath(value any) []string {
	raw := []string{}
	switch typed := value.(type) {
	case []string:
		raw = append(raw, typed...)
	case []any:
		for _, item := range typed {
			raw = append(raw, toStr(item))
		}
	case string:
		raw = append(raw, typed)
	default:
		return []string{}
	}

	parts := []string{}
	for _, item := range raw {
		for _, fragment := range knowledgeCategorySeparatorRe.Split(item, -1) {
			part := strings.TrimSpace(strings.Trim(trimSpace(fragment), `"'“”‘’[]（）()`))
			if part == "" || knowledgeCategoryBannedRe.MatchString(part) {
				continue
			}
			part = truncateRunes(part, 40)
			if slices.Contains(parts, part) {
				continue
			}
			parts = append(parts, part)
			if len(parts) == 2 {
				return parts
			}
		}
	}
	return parts
}

func isKnowledgeTaxonomyFallbackPath(path []string) bool {
	return len(path) == 1 && path[0] == knowledgeTaxonomyFallbackLabel
}

func sortedKnowledgeTaxonomyKeys(values map[string][]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func formatKnowledgeTaxonomyTree(paths [][]string) string {
	type node struct{ children map[string]*node }
	root := &node{children: map[string]*node{}}
	for _, rawPath := range paths {
		current := root
		for _, label := range normalizeKnowledgeCategoryPath(rawPath) {
			child := current.children[label]
			if child == nil {
				child = &node{children: map[string]*node{}}
				current.children[label] = child
			}
			current = child
		}
	}
	var lines []string
	var walk func(map[string]*node, int)
	walk = func(children map[string]*node, depth int) {
		labels := make([]string, 0, len(children))
		for label := range children {
			labels = append(labels, label)
		}
		sort.Strings(labels)
		for _, label := range labels {
			lines = append(lines, strings.Repeat("  ", depth)+"- "+label)
			walk(children[label].children, depth+1)
		}
	}
	walk(root.children, 0)
	return strings.Join(lines, "\n")
}
