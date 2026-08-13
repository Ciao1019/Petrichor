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
	// wikiTaxonomyPlanChunkSize 限制单次规划调用携带的页面数量。超出的部分分批规划，
	// 前一批新建的目录会作为「已有目录」喂给后一批，让整棵树收敛到一致的命名。
	wikiTaxonomyPlanChunkSize = 60
	// wikiTaxonomyPromptMaxPaths 限制 Prompt 里渲染的已有目录数量。
	wikiTaxonomyPromptMaxPaths = 150
	// wikiTaxonomyEmptyTreeHint 是知识库还没有任何目录时给模型的提示。
	wikiTaxonomyEmptyTreeHint = "(当前知识库还没有任何目录，请设计一套全新的目录)"
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

// planWikiTaxonomy 在一次规划中给整批实体/概念页面分配目录路径，让它们落在同一棵
// 一致的目录树上，并尽量复用知识库里已有的目录。逐页并行地各自发明目录无法收敛，
// 在知识库还没有任何目录的首批构建上尤其糟糕。返回值按 pageKey 索引，
// 值为空切片表示该页面确实没有合适的归属，挂在根目录下。
func (s *Service) planWikiTaxonomy(
	ctx context.Context, modelCfg *ent.AIModelConfig, userID, kbID int64, items []wikiTaxonomyItem,
) map[string][]string {
	if len(items) == 0 {
		return nil
	}
	existing := s.listWikiCategoryPaths(ctx, userID, kbID)
	result := make(map[string][]string, len(items))
	for start := 0; start < len(items); start += wikiTaxonomyPlanChunkSize {
		end := min(start+wikiTaxonomyPlanChunkSize, len(items))
		chunk := items[start:end]

		tree := formatWikiTaxonomyTree(existing)
		if strings.TrimSpace(tree) == "" {
			tree = wikiTaxonomyEmptyTreeHint
		}
		var itemsBlock strings.Builder
		for _, item := range chunk {
			fmt.Fprintf(&itemsBlock, "- key: %s | 标题: %s | 类型: %s | 简述: %s\n",
				item.pageKey, item.title, item.kind, truncateRunes(item.about, 120))
		}

		userPrompt := strings.NewReplacer(
			"{{EXISTING_TAXONOMY}}", tree,
			"{{ITEMS}}", itemsBlock.String(),
		).Replace(wikiTaxonomyUserPrompt)
		raw, err := s.wikiChat(ctx, modelCfg, "wiki-taxonomy", wikiTaxonomySystemPrompt(), userPrompt)
		if err != nil {
			s.log.Warn("wiki taxonomy plan failed", zap.Int64("knowledge_base_id", kbID), zap.Int("items", len(chunk)), zap.Error(err))
			continue
		}
		var parsed struct {
			Assignments []struct {
				Key  string   `json:"key"`
				Path []string `json:"path"`
			} `json:"assignments"`
		}
		if err := decodeWikiJSON(raw, &parsed); err != nil {
			s.log.Warn("wiki taxonomy plan decode failed", zap.Int64("knowledge_base_id", kbID), zap.Error(err),
				zap.String("preview", safeWikiModelOutputPreview(raw)))
			continue
		}
		for _, assignment := range parsed.Assignments {
			key := normalizeWikiPageKey(assignment.Key)
			if key == "" {
				continue
			}
			path := cleanWikiCategoryPath(assignment.Path)
			result[key] = path
			if len(path) > 0 {
				existing = append(existing, path) // 喂给后续批次，让整棵树收敛
			}
		}
	}
	return result
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
		if len(path) == 0 {
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
func (s *Service) assignWikiCategories(ctx context.Context, modelCfg *ent.AIModelConfig, userID, kbID int64, affected map[string]struct{}) error {
	if len(affected) == 0 {
		return nil
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
		return err
	}
	pending := make([]wikiTaxonomyItem, 0, len(rows))
	byKey := make(map[string]*ent.KBWikiPage, len(rows))
	for _, row := range rows {
		if len(decodeWikiCategoryPath(row.CategoryPathJSON)) > 0 {
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
		return nil
	}
	s.log.Info("wiki taxonomy planning started", zap.Int64("knowledge_base_id", kbID), zap.Int("pages", len(pending)))

	planned := s.planWikiTaxonomy(ctx, modelCfg, userID, kbID, pending)
	filed := 0
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
			continue
		}
		filed++
	}
	s.log.Info("wiki taxonomy planning completed", zap.Int64("knowledge_base_id", kbID),
		zap.Int("planned", len(pending)), zap.Int("filed", filed))
	return nil
}
