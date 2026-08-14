package kb

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"

	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
)

const (
	// wikiCategoryMaxDepth 是页面目录链的硬上限。Prompt 只要求模型给两级，
	// 这里多留一级作为防御边界，避免模型过度细分把目录树撑成无限面包屑。
	wikiCategoryMaxDepth = 3
	// wikiTaxonomyPlanChunkSize 限制单次规划调用携带的页面数量。目录规划要求模型返回
	// 完整 JSON，批次过大会明显增加截断或漏项概率；20 页能兼顾目录一致性和输出稳定性。
	// 前一批新建的目录会作为「已有目录」喂给后一批，让整棵树收敛到一致的命名。
	wikiTaxonomyPlanChunkSize = 20
	// wikiTaxonomyPlanAttempts 对结构化输出解析失败、漏项或空目录进行补偿重试。
	// wikiChat 自身只负责 HTTP/空响应重试，两层职责不能混在一起。
	wikiTaxonomyPlanAttempts = 2
	// wikiTaxonomyPromptMaxPaths 限制 Prompt 里渲染的已有目录数量。
	wikiTaxonomyPromptMaxPaths = 150
	// wikiTaxonomyEmptyTreeHint 是知识库还没有任何目录时给模型的提示。
	wikiTaxonomyEmptyTreeHint = "(当前知识库还没有任何目录，请设计一套全新的目录)"
	// wikiTaxonomyFallbackLabel 保证模型持续不可用时页面仍呈现为目录树，而不是静默平铺。
	// assignWikiCategories 会把该目录视为待重试状态，后续构建仍会重新规划。
	wikiTaxonomyFallbackLabel = "待整理"
)

var wikiCategorySeparatorReplacer = strings.NewReplacer("／", "/", "｜", "/", "|", "/")

// cleanWikiCategoryPart 归一化单个目录标签：拆掉内嵌分隔符、去掉包裹的引号括号，
// 并丢弃 "entity"/"实体" 这类页面类型噪声（类型不该成为目录）。
func cleanWikiCategoryPart(part string) []string {
	part = strings.TrimSpace(part)
	if part == "" {
		return nil
	}
	part = wikiCategorySeparatorReplacer.Replace(part)
	out := make([]string, 0, 2)
	for _, raw := range strings.Split(part, "/") {
		label := strings.TrimSpace(strings.Trim(strings.TrimSpace(raw), `"'“”‘’[]（）()`))
		if label == "" || isWikiTypeCategoryLabel(label) {
			continue
		}
		out = append(out, truncateRunes(label, 40))
	}
	return out
}

// cleanWikiCategoryPath 清洗、去重并把目录链截断到 wikiCategoryMaxDepth。
// 写入和查询都走这个函数，保证存下来的路径和用来筛选的路径归一化方式完全一致。
func cleanWikiCategoryPath(parts []string) []string {
	cleaned := make([]string, 0, len(parts))
	for _, part := range parts {
		for _, label := range cleanWikiCategoryPart(part) {
			if slices.Contains(cleaned, label) {
				continue
			}
			cleaned = append(cleaned, label)
			if len(cleaned) >= wikiCategoryMaxDepth {
				return cleaned
			}
		}
	}
	return cleaned
}

func isWikiTypeCategoryLabel(label string) bool {
	switch strings.TrimSuffix(strings.ToLower(strings.TrimSpace(label)), "s") {
	case "entity", "实体", "實體", "concept", "概念", "summary", "摘要", "index", "索引", "wiki", "页面", "頁面":
		return true
	default:
		return false
	}
}

// decodeWikiCategoryPath 解析页面存储的 category_path_json。
func decodeWikiCategoryPath(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var path []string
	if err := json.Unmarshal([]byte(*raw), &path); err != nil {
		return nil
	}
	return cleanWikiCategoryPath(path)
}

type wikiTaxonomyItem struct {
	pageKey string
	title   string
	kind    string
	about   string
}

func isWikiTaxonomyFallbackPath(path []string) bool {
	return len(path) == 1 && path[0] == wikiTaxonomyFallbackLabel
}

// wikiTaxonomyKeyAliases 兼容模型偶发省略 entity/concept 前缀或返回页面标题。
// 只有唯一别名才参与匹配，避免同名页面被错误归档。
func wikiTaxonomyKeyAliases(items []wikiTaxonomyItem) map[string]string {
	aliases := make(map[string]string, len(items)*3)
	add := func(alias, pageKey string) {
		alias = normalizeWikiPageKey(alias)
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
		add(item.pageKey, item.pageKey)
		if _, suffix, ok := strings.Cut(item.pageKey, "/"); ok {
			add(suffix, item.pageKey)
		}
		add(item.title, item.pageKey)
	}
	return aliases
}

// planWikiTaxonomy 在一次规划中给整批实体/概念页面分配目录路径，让它们落在同一棵
// 一致的目录树上，并尽量复用知识库里已有的目录。逐页并行地各自发明目录无法收敛，
// 在知识库还没有任何目录的首批构建上尤其糟糕。返回值按 pageKey 索引，
// 值为空切片表示该页面确实没有合适的归属，挂在根目录下。
func (s *Service) planWikiTaxonomy(
	ctx context.Context, modelCfg *ent.AIModelConfig, userID, kbID int64, items []wikiTaxonomyItem,
) (map[string][]string, []string) {
	return s.planWikiTaxonomyFromExisting(ctx, modelCfg, kbID, items, s.listWikiCategoryPaths(ctx, userID, kbID))
}

// planWikiTaxonomyFromExisting 允许显式传入已有目录。常规增量构建传数据库目录以维持稳定；
// 管理端全量重整可传 nil，让模型从页面集合重新设计目录而不受旧分类约束。
func (s *Service) planWikiTaxonomyFromExisting(
	ctx context.Context, modelCfg *ent.AIModelConfig, kbID int64, items []wikiTaxonomyItem, existing [][]string,
) (map[string][]string, []string) {
	if len(items) == 0 {
		return nil, nil
	}
	result := make(map[string][]string, len(items))
	warnings := make([]string, 0)
	for start := 0; start < len(items); start += wikiTaxonomyPlanChunkSize {
		end := min(start+wikiTaxonomyPlanChunkSize, len(items))
		pending := append([]wikiTaxonomyItem(nil), items[start:end]...)
		lastIssue := "模型没有返回完整目录"
		for attempt := 0; attempt < wikiTaxonomyPlanAttempts && len(pending) > 0; attempt++ {
			tree := formatWikiTaxonomyTree(existing)
			if strings.TrimSpace(tree) == "" {
				tree = wikiTaxonomyEmptyTreeHint
			}
			var itemsBlock strings.Builder
			for _, item := range pending {
				fmt.Fprintf(&itemsBlock, "- key: %s | 标题: %s | 类型: %s | 简述: %s\n",
					item.pageKey, item.title, item.kind, truncateRunes(item.about, 120))
			}

			userPrompt := strings.NewReplacer(
				"{{EXISTING_TAXONOMY}}", tree,
				"{{ITEMS}}", itemsBlock.String(),
			).Replace(wikiTaxonomyUserPrompt)
			raw, err := s.wikiChat(ctx, modelCfg, "wiki-taxonomy", wikiTaxonomySystemPrompt(), userPrompt)
			if err != nil {
				lastIssue = "模型请求失败"
				s.log.Warn("wiki taxonomy plan failed", zap.Int64("knowledge_base_id", kbID),
					zap.Int("batch", start/wikiTaxonomyPlanChunkSize+1), zap.Int("attempt", attempt+1),
					zap.Int("items", len(pending)), zap.Error(err))
				continue
			}
			var parsed struct {
				Assignments []struct {
					Key  string   `json:"key"`
					Path []string `json:"path"`
				} `json:"assignments"`
			}
			if err := decodeWikiJSON(raw, &parsed); err != nil {
				lastIssue = "模型输出格式错误"
				s.log.Warn("wiki taxonomy plan decode failed", zap.Int64("knowledge_base_id", kbID),
					zap.Int("batch", start/wikiTaxonomyPlanChunkSize+1), zap.Int("attempt", attempt+1), zap.Error(err),
					zap.String("preview", safeWikiModelOutputPreview(raw)))
				continue
			}

			aliases := wikiTaxonomyKeyAliases(pending)
			for _, assignment := range parsed.Assignments {
				key := aliases[normalizeWikiPageKey(assignment.Key)]
				path := cleanWikiCategoryPath(assignment.Path)
				if key == "" || len(path) == 0 {
					continue
				}
				result[key] = path
				existing = append(existing, path) // 喂给重试和后续批次，让整棵树收敛
			}
			next := pending[:0]
			for _, item := range pending {
				if len(result[item.pageKey]) == 0 {
					next = append(next, item)
				}
			}
			pending = next
			if len(pending) > 0 {
				lastIssue = "模型漏掉部分页面"
			}
		}

		if len(pending) > 0 {
			for _, item := range pending {
				result[item.pageKey] = []string{wikiTaxonomyFallbackLabel}
			}
			warning := fmt.Sprintf("Wiki 目录规划第 %d 批有 %d 个页面暂时归入“%s”（%s），后续构建会自动重试",
				start/wikiTaxonomyPlanChunkSize+1, len(pending), wikiTaxonomyFallbackLabel, lastIssue)
			warnings = append(warnings, warning)
			s.log.Warn("wiki taxonomy plan used fallback", zap.Int64("knowledge_base_id", kbID),
				zap.Int("batch", start/wikiTaxonomyPlanChunkSize+1), zap.Int("items", len(pending)), zap.String("reason", lastIssue))
		}
	}
	return result, warnings
}

// listWikiCategoryPaths 读取知识库里已存在的目录链，作为复用锚点。
func (s *Service) listWikiCategoryPaths(ctx context.Context, userID, kbID int64) [][]string {
	rows, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
		kbwikipage.CategoryPathJSONNotNil(),
	).Select(kbwikipage.FieldCategoryPathJSON).All(ctx)
	if err != nil {
		s.log.Warn("list wiki category paths failed", zap.Int64("knowledge_base_id", kbID), zap.Error(err))
		return nil
	}
	seen := make(map[string]struct{}, len(rows))
	out := make([][]string, 0, len(rows))
	for _, row := range rows {
		path := decodeWikiCategoryPath(row.CategoryPathJSON)
		if len(path) == 0 || isWikiTaxonomyFallbackPath(path) {
			continue
		}
		key := strings.Join(path, "/")
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, path)
		if len(out) >= wikiTaxonomyPromptMaxPaths {
			break
		}
	}
	return out
}

// formatWikiTaxonomyTree 把目录链集合渲染成缩进树，比逐行罗列完整路径更省 token，
// 也更容易让模型看出层级归属。
func formatWikiTaxonomyTree(paths [][]string) string {
	type node struct{ children map[string]*node }
	root := &node{children: map[string]*node{}}
	for _, path := range paths {
		current := root
		for _, label := range path {
			if current.children == nil {
				current.children = map[string]*node{}
			}
			child, exists := current.children[label]
			if !exists {
				child = &node{children: map[string]*node{}}
				current.children[label] = child
			}
			current = child
		}
	}
	var buf strings.Builder
	var walk func(name string, current *node, depth int)
	walk = func(name string, current *node, depth int) {
		fmt.Fprintf(&buf, "%s- %s\n", strings.Repeat("  ", depth), name)
		labels := make([]string, 0, len(current.children))
		for label := range current.children {
			labels = append(labels, label)
		}
		sort.Strings(labels)
		for _, label := range labels {
			walk(label, current.children[label], depth+1)
		}
	}
	labels := make([]string, 0, len(root.children))
	for label := range root.children {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	for _, label := range labels {
		walk(label, root.children[label], 0)
	}
	return strings.TrimSpace(buf.String())
}

// assignWikiCategories 给本次构建涉及到、且还没有目录的实体/概念页面规划并写入目录。
// 已经有目录的页面不会被churn，用户后续手动调整也因此得以保留。
func (s *Service) assignWikiCategories(ctx context.Context, modelCfg *ent.AIModelConfig, userID, kbID int64, affected map[string]struct{}) ([]string, error) {
	if len(affected) == 0 {
		return nil, nil
	}
	keys := make([]string, 0, len(affected))
	for key := range affected {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	rows, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
		kbwikipage.PageKeyIn(keys...), kbwikipage.KindIn("entity", "concept"),
	).Order(ent.Asc(kbwikipage.FieldPageKey)).All(ctx)
	if err != nil {
		return nil, err
	}
	pending := make([]wikiTaxonomyItem, 0, len(rows))
	byKey := make(map[string]*ent.KBWikiPage, len(rows))
	for _, row := range rows {
		path := decodeWikiCategoryPath(row.CategoryPathJSON)
		if len(path) > 0 && !isWikiTaxonomyFallbackPath(path) {
			continue
		}
		about := ""
		if row.Summary != nil {
			about = strings.TrimSpace(*row.Summary)
		}
		if about == "" {
			about = markdownToPlainText(row.ContentMd)
		}
		byKey[row.PageKey] = row
		pending = append(pending, wikiTaxonomyItem{pageKey: row.PageKey, title: row.Title, kind: row.Kind, about: about})
	}
	if len(pending) == 0 {
		return nil, nil
	}
	s.log.Info("wiki taxonomy planning started", zap.Int64("knowledge_base_id", kbID), zap.Int("pages", len(pending)))

	planned, warnings := s.planWikiTaxonomy(ctx, modelCfg, userID, kbID, pending)
	filed := 0
	writeFailures := 0
	for key, path := range planned {
		row := byKey[key]
		if row == nil || len(path) == 0 {
			continue
		}
		encoded, marshalErr := json.Marshal(path)
		if marshalErr != nil {
			continue
		}
		if _, err := row.Update().SetCategoryPathJSON(string(encoded)).Save(ctx); err != nil {
			s.log.Warn("apply wiki category failed", zap.String("page_key", key), zap.Error(err))
			writeFailures++
			continue
		}
		filed++
	}
	s.log.Info("wiki taxonomy planning completed", zap.Int64("knowledge_base_id", kbID),
		zap.Int("planned", len(pending)), zap.Int("filed", filed))
	if writeFailures > 0 {
		return warnings, fmt.Errorf("%d 个 Wiki 页面的目录写入失败", writeFailures)
	}
	return warnings, nil
}
