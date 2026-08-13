package kb

import (
	"context"
	"sort"
	"strings"

	"go.uber.org/zap"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbwikipage"
)

const (
	// wikiDedupCandidateTopK 限制每个新条目最多带多少个相似的已有页面进 Prompt。
	// 刻意取小值：真正同一实体的目标基本都排在最前，候选越短模型判断越准，token 也更省。
	wikiDedupCandidateTopK = 5
	// wikiDedupScoreFloor 是 Jaccard 相似度下限。达到这个分数的页面一定会进候选，
	// 不受 TopK 限制。取值让「Acme Corp」对「Acme Corporation」（≈0.5）稳过，
	// 而毫不相干的两个词（0）被排除。
	wikiDedupScoreFloor = 0.08
	// wikiDedupSmallCorpusBypass：已有页面本来就少时直接全量喂给模型。
	// 预筛只有在页面很多时才划算，页面少时反而可能误砍掉正确的合并目标。
	wikiDedupSmallCorpusBypass = 25
)

// wikiDedupSurface 是参与相似度比较的一侧预计算特征。
type wikiDedupSurface struct {
	// slugTokens 是 slug 去掉类型前缀后的 kebab-case 词元。slug 和表面名称
	// 属于两个不同的符号空间（中文页面的 slug 往往是拼音），互为补充信号。
	slugTokens map[string]struct{}
	// nameGrams 每个表面形式（名称与各个别名）一组字符二元组。分开存放是为了
	// 让配对分数取「各表面形式的最大值」——某个别名命中不该被主名称的不匹配稀释。
	nameGrams []map[string]struct{}
}

// wikiDedupMerge 是一次通过校验的合并：把新抽取的 fromSlug 并入已有的 toSlug。
type wikiDedupMerge struct {
	From string
	To   string
}

// deduplicateWikiItems 把新抽取的实体/概念与知识库里已有的同类页面比对，
// 将「同一事物的不同写法」（缩写↔全称、翻译、拼写差异）合并到已有页面上。
// 没有这一步，「小鼹鼠」「Mole」「mole」会各自成页，Wiki 很快就散掉。
//
// 返回值是 slug 重写表；调用方据此把新条目的 slug 换成已有页面的 slug。
func (s *Service) deduplicateWikiItems(
	ctx context.Context, modelCfg *ent.AIModelConfig, userID, kbID int64, items []wikiExtractedItem,
) map[string]string {
	if len(items) == 0 {
		return nil
	}
	existing, err := s.client.KBWikiPage.Query().Where(
		kbwikipage.UserIDEQ(userID), kbwikipage.KnowledgeBaseIDEQ(kbID), kbwikipage.ArchivedAtIsNil(),
		kbwikipage.KindIn("entity", "concept"),
	).Order(ent.Asc(kbwikipage.FieldPageKey)).All(ctx)
	if err != nil {
		s.log.Warn("wiki dedup load existing pages failed", zap.Int64("knowledge_base_id", kbID), zap.Error(err))
		return nil
	}
	if len(existing) == 0 {
		return nil
	}

	// 已有页面自身的 slug 集合：新条目 slug 已经和某个页面完全一致时无需再判重。
	existingSlugs := make(map[string]struct{}, len(existing))
	for _, page := range existing {
		existingSlugs[page.PageKey] = struct{}{}
	}
	fresh := make([]wikiExtractedItem, 0, len(items))
	for _, item := range items {
		if _, exists := existingSlugs[item.Slug]; exists {
			continue
		}
		fresh = append(fresh, item)
	}
	if len(fresh) == 0 {
		return nil
	}

	candidates := selectWikiDedupCandidates(fresh, existing)
	if len(candidates) == 0 {
		return nil
	}

	var block strings.Builder
	for _, item := range fresh {
		pages := candidates[item.Slug]
		if len(pages) == 0 {
			continue
		}
		block.WriteString("<item>\n")
		block.WriteString("  slug: " + item.Slug + "\n")
		block.WriteString("  name: " + item.Name + "\n")
		if len(item.Aliases) > 0 {
			block.WriteString("  aliases: " + strings.Join(item.Aliases, ", ") + "\n")
		}
		block.WriteString("  about: " + truncateRunes(item.Description, 100) + "\n")
		block.WriteString("  <candidates>\n")
		for _, page := range pages {
			block.WriteString("    <page slug=\"" + page.PageKey + "\">" + page.Title + "</page>\n")
		}
		block.WriteString("  </candidates>\n</item>\n")
	}
	if block.Len() == 0 {
		return nil
	}

	raw, err := s.wikiChat(ctx, modelCfg, "wiki-dedup", wikiDedupSystemPrompt(),
		strings.ReplaceAll(wikiDedupUserPrompt, "{{ITEMS}}", block.String()))
	if err != nil {
		s.log.Warn("wiki dedup call failed", zap.Int64("knowledge_base_id", kbID), zap.Error(err))
		return nil
	}
	var parsed struct {
		Merges map[string]string `json:"merges"`
	}
	if err := decodeWikiJSON(raw, &parsed); err != nil {
		s.log.Warn("wiki dedup decode failed", zap.Int64("knowledge_base_id", kbID), zap.Error(err),
			zap.String("preview", safeWikiModelOutputPreview(raw)))
		return nil
	}

	out := make(map[string]string, len(parsed.Merges))
	for from, to := range parsed.Merges {
		from, to = normalizeExistingWikiSlug(from), normalizeExistingWikiSlug(to)
		allowed := make(map[string]struct{}, len(candidates[from]))
		for _, page := range candidates[from] {
			allowed[page.PageKey] = struct{}{}
		}
		if reason := wikiDedupRejectReason(from, to, allowed); reason != "" {
			s.log.Info("wiki dedup merge rejected", zap.String("from", from), zap.String("to", to), zap.String("reason", reason))
			continue
		}
		out[from] = to
	}
	if len(out) > 0 {
		s.log.Info("wiki dedup merges accepted", zap.Int64("knowledge_base_id", kbID), zap.Int("merges", len(out)))
	}
	return out
}

// applyWikiDedupMerges 按重写表把新条目的 slug 换成已有页面的 slug。
// 合并后若有多个条目指向同一个 slug，只保留第一个并把别名并进去，
// 让这篇文档对该页面只产生一份贡献。
func applyWikiDedupMerges(items []wikiExtractedItem, merges map[string]string) []wikiExtractedItem {
	if len(merges) == 0 {
		return items
	}
	out := make([]wikiExtractedItem, 0, len(items))
	indexBySlug := make(map[string]int, len(items))
	for _, item := range items {
		if target, ok := merges[item.Slug]; ok {
			// 原来的名称仍是该页面的一个有效别名，保留下来有助于后续判重和检索。
			item.Aliases = uniqueNonEmpty(append(item.Aliases, item.Name))
			item.Slug = target
		}
		if existing, seen := indexBySlug[item.Slug]; seen {
			out[existing].Aliases = uniqueNonEmpty(append(out[existing].Aliases, item.Aliases...))
			// 被并掉的条目的证据分片同样属于目标页面，丢掉会让页面失去来源。
			out[existing].SourceChunks = uniqueSortedInts(append(out[existing].SourceChunks, item.SourceChunks...))
			continue
		}
		indexBySlug[item.Slug] = len(out)
		out = append(out, item)
	}
	return out
}

// wikiDedupRejectReason 用与模型无关的确定性规则校验一次合并提案，
// 通过时返回空串。这道闸门比依赖模型自觉可靠得多。
func wikiDedupRejectReason(from, to string, allowed map[string]struct{}) string {
	if from == "" || to == "" {
		return "空 slug"
	}
	if from == to {
		return "合并到自身"
	}
	// 目标必须来自该条目自己的候选集。Prompt 里每个条目的候选是独立的，
	// 这条规则能挡掉模型把 A 条目合并到只与 B 条目相似的页面上。
	if _, ok := allowed[to]; !ok {
		return "目标不在该条目的相似候选内"
	}
	fromSlash, toSlash := strings.Index(from, "/"), strings.Index(to, "/")
	if fromSlash <= 0 || toSlash <= 0 {
		return "缺少类型前缀"
	}
	if from[:fromSlash] != to[:toSlash] {
		// 实体只能并入实体，概念只能并入概念。
		return "类型不一致：" + from[:fromSlash] + " vs " + to[:toSlash]
	}
	return ""
}

// selectWikiDedupCandidates 为每个新条目挑出可能同源的已有页面，按条目 slug 返回。
func selectWikiDedupCandidates(items []wikiExtractedItem, pages []*ent.KBWikiPage) map[string][]*ent.KBWikiPage {
	if len(pages) == 0 {
		return nil
	}
	pageFeatures := make([]wikiDedupSurface, len(pages))
	for index, page := range pages {
		pageFeatures[index] = wikiDedupSurface{
			slugTokens: wikiSlugBaseTokens(page.PageKey),
			nameGrams:  wikiSurfaceGrams(append([]string{page.Title}, wikiPageAliases(page)...)),
		}
	}

	out := make(map[string][]*ent.KBWikiPage, len(items))
	for _, item := range items {
		feature := wikiDedupSurface{
			slugTokens: wikiSlugBaseTokens(item.Slug),
			nameGrams:  wikiSurfaceGrams(append([]string{item.Name}, item.Aliases...)),
		}
		if len(feature.slugTokens) == 0 && len(feature.nameGrams) == 0 {
			continue
		}
		// 已有页面很少时全部喂给模型，预筛在这种规模下只会误伤。
		if len(pages) <= wikiDedupSmallCorpusBypass {
			out[item.Slug] = pages
			continue
		}

		type scored struct {
			index int
			score float64
		}
		ranking := make([]scored, len(pageFeatures))
		for index := range pageFeatures {
			ranking[index] = scored{index, wikiDedupPairScore(feature, pageFeatures[index])}
		}
		sort.SliceStable(ranking, func(left, right int) bool { return ranking[left].score > ranking[right].score })

		selected := make([]*ent.KBWikiPage, 0, wikiDedupCandidateTopK)
		budget := wikiDedupCandidateTopK
		for _, entry := range ranking {
			if entry.score >= wikiDedupScoreFloor {
				selected = append(selected, pages[entry.index])
				continue
			}
			// 低于下限但仍给模型留几个候选，让它能明确地「拒绝合并」；
			// 分数为 0 表示毫无共同点，放进去只会诱发幻觉。
			if budget > 0 && entry.score > 0 {
				selected = append(selected, pages[entry.index])
				budget--
				continue
			}
			break
		}
		if len(selected) > 0 {
			out[item.Slug] = selected
		}
	}
	return out
}

// wikiDedupPairScore 取两侧所有表面形式之间的最高 Jaccard 相似度，
// 以及 slug 词元的相似度，两者取最大值。
func wikiDedupPairScore(left, right wikiDedupSurface) float64 {
	best := wikiJaccard(left.slugTokens, right.slugTokens)
	for _, leftGrams := range left.nameGrams {
		for _, rightGrams := range right.nameGrams {
			if score := wikiJaccard(leftGrams, rightGrams); score > best {
				best = score
			}
		}
	}
	return best
}

func wikiJaccard(left, right map[string]struct{}) float64 {
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	intersection := 0
	small, large := left, right
	if len(small) > len(large) {
		small, large = large, small
	}
	for key := range small {
		if _, ok := large[key]; ok {
			intersection++
		}
	}
	if intersection == 0 {
		return 0
	}
	return float64(intersection) / float64(len(left)+len(right)-intersection)
}

// wikiSlugBaseTokens 取 slug 去掉类型前缀后的词元集合。
func wikiSlugBaseTokens(slug string) map[string]struct{} {
	base := slug
	if index := strings.LastIndex(slug, "/"); index >= 0 {
		base = slug[index+1:]
	}
	out := make(map[string]struct{})
	for _, token := range strings.FieldsFunc(strings.ToLower(base), func(r rune) bool {
		return r == '-' || r == '_' || r == '.' || r == ' '
	}) {
		if token != "" {
			out[token] = struct{}{}
		}
	}
	return out
}

// wikiSurfaceGrams 给每个非空表面形式生成一组字符二元组。
func wikiSurfaceGrams(surfaces []string) []map[string]struct{} {
	out := make([]map[string]struct{}, 0, len(surfaces))
	for _, surface := range surfaces {
		grams := wikiBigrams(surface)
		if len(grams) > 0 {
			out = append(out, grams)
		}
	}
	return out
}

// wikiBigrams 按字符（而非字节）切二元组，单字符输入退化为它本身，
// 这样「猫」这类单字名称也有可比较的特征。
func wikiBigrams(value string) map[string]struct{} {
	runes := []rune(strings.ToLower(strings.Join(strings.Fields(value), "")))
	out := make(map[string]struct{})
	if len(runes) == 0 {
		return out
	}
	if len(runes) == 1 {
		out[string(runes)] = struct{}{}
		return out
	}
	for index := 0; index+1 < len(runes); index++ {
		out[string(runes[index:index+2])] = struct{}{}
	}
	return out
}
