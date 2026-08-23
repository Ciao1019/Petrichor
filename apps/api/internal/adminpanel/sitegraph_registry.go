// sitegraph_registry.go 移植 src/server/site-graph/entity-registry.ts：
// 实体注册表，解决同一事物在不同文章/批次里被起了不同名字的问题。
package adminpanel

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"
)

var entityNameStripPattern = regexp.MustCompile(`[^\p{L}\p{N}]+`)

// ENTITY_CANDIDATE_THRESHOLD 模糊相似度候选阈值。
const EntityCandidateThreshold = 0.62

// minContainmentLength 互为子串时较短一方的最小长度，避免「AI」命中一切。
const minContainmentLength = 3

// maxCandidates 候选上限。
const maxCandidates = 100

// shortNameLength 中文术语普遍长度。
const shortNameLength = 6

// NormalizeEntityName 匹配用名称归一化：NFKC 折叠全角、转小写、去掉所有空白与标点。
func NormalizeEntityName(raw string) string {
	folded := norm.NFKC.String(raw)
	lowered := strings.ToLower(folded)
	return entityNameStripPattern.ReplaceAllString(lowered, "")
}

func bigrams(text []rune) []string {
	if len(text) < 2 {
		if len(text) == 1 {
			return []string{string(text[0])}
		}
		return nil
	}
	grams := make([]string, 0, len(text)-1)
	for i := 0; i+1 < len(text); i++ {
		grams = append(grams, string(text[i:i+2]))
	}
	return grams
}

// diceCoefficient Dice 系数：两个多重集合的重合度，0~1。
func diceCoefficient(left, right []string) float64 {
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	counts := make(map[string]int, len(left))
	for _, token := range left {
		counts[token]++
	}
	hits := 0
	for _, token := range right {
		if remaining := counts[token]; remaining > 0 {
			hits++
			counts[token] = remaining - 1
		}
	}
	return (2 * float64(hits)) / float64(len(left)+len(right))
}

// NameSimilarity 名称相似度 0~1：二元组重合度为主，短串补字符级重合度信号。
func NameSimilarity(left, right string) float64 {
	leftRunes := []rune(left)
	rightRunes := []rune(right)
	if len(leftRunes) == 0 || len(rightRunes) == 0 {
		return 0
	}
	if left == right {
		return 1
	}

	bigramScore := diceCoefficient(bigrams(leftRunes), bigrams(rightRunes))
	shorter := len(leftRunes)
	if len(rightRunes) < shorter {
		shorter = len(rightRunes)
	}
	if shorter > shortNameLength {
		return bigramScore
	}
	unigramScore := diceCoefficient(runesToStrings(leftRunes), runesToStrings(rightRunes)) * 0.9
	if unigramScore > bigramScore {
		return unigramScore
	}
	return bigramScore
}

func runesToStrings(runas []rune) []string {
	out := make([]string, len(runas))
	for i, r := range runas {
		out[i] = string(r)
	}
	return out
}

// EntityRegistryEntry 注册表条目（库里已有的概念/实体）。
type EntityRegistryEntry struct {
	CanonicalKey string   `json:"canonicalKey"`
	Name         string   `json:"name"`
	Aliases      []string `json:"aliases"`
	Kind         string   `json:"kind"`
	Weight       int32    `json:"weight"`
}

type entityMatchKind int

const (
	matchKey entityMatchKind = iota
	matchName
	matchAlias
	matchNone
)

type entityResolveResult struct {
	canonicalKey string
	match        entityMatchKind
	candidate    *MergeCandidate
}

// SiteGraphEntityRegistry 纯内存实体注册表。
type SiteGraphEntityRegistry struct {
	byKey         map[string]*EntityRegistryEntry
	keyOrder      []string          // 保持与 TS Map 一致的插入序遍历
	invertedIndex map[string]string // 规范化名称 → 规范键
	candidates    []*MergeCandidate
}

// NewSiteGraphEntityRegistry 用库中已有实体初始化注册表。
func NewSiteGraphEntityRegistry(entries []EntityRegistryEntry) *SiteGraphEntityRegistry {
	r := &SiteGraphEntityRegistry{
		byKey:         map[string]*EntityRegistryEntry{},
		invertedIndex: map[string]string{},
	}
	for _, entry := range entries {
		copied := entry
		r.register(&copied)
	}
	return r
}

// register 把一个实体及其全部别名写进倒排索引；重复注册做并集。
func (r *SiteGraphEntityRegistry) register(entry *EntityRegistryEntry) {
	existing, ok := r.byKey[entry.CanonicalKey]
	if ok {
		mergedAliases := dedupeAliases(append(append([]string{}, existing.Aliases...), entry.Aliases...))
		existing.Aliases = mergedAliases
		if entry.Weight > existing.Weight {
			existing.Weight = entry.Weight
		}
		entry = existing
	} else {
		entry.Aliases = dedupeAliases(entry.Aliases)
		copied := *entry
		r.byKey[entry.CanonicalKey] = &copied
		r.keyOrder = append(r.keyOrder, entry.CanonicalKey)
	}

	labels := append([]string{entry.Name}, entry.Aliases...)
	for _, label := range labels {
		normalized := NormalizeEntityName(label)
		if normalized == "" {
			continue
		}
		// 先注册者占位，避免后来的同义词把已有规范键顶掉
		if _, exists := r.invertedIndex[normalized]; !exists {
			r.invertedIndex[normalized] = entry.CanonicalKey
		}
	}
}

// resolve 把新抽取节点对齐到注册表；仅相近时额外返回合并候选。
func (r *SiteGraphEntityRegistry) resolve(node *DraftNode) entityResolveResult {
	if _, exists := r.byKey[node.NodeKey]; exists {
		return entityResolveResult{canonicalKey: node.NodeKey, match: matchKey}
	}

	normalizedName := NormalizeEntityName(node.Name)
	if normalizedName != "" {
		if hit, found := r.invertedIndex[normalizedName]; found {
			return entityResolveResult{canonicalKey: hit, match: matchName}
		}
	}

	for _, alias := range node.Aliases {
		normalizedAlias := NormalizeEntityName(alias)
		if normalizedAlias == "" {
			continue
		}
		if hit, found := r.invertedIndex[normalizedAlias]; found {
			return entityResolveResult{canonicalKey: hit, match: matchAlias}
		}
	}

	candidate := r.findCandidate(node, normalizedName)
	return entityResolveResult{canonicalKey: node.NodeKey, match: matchNone, candidate: candidate}
}

// findCandidate 模糊比对：只产候选，不改键。
func (r *SiteGraphEntityRegistry) findCandidate(node *DraftNode, normalizedName string) *MergeCandidate {
	if normalizedName == "" {
		return nil
	}

	var best *MergeCandidate
	for _, key := range r.keyOrder {
		entry := r.byKey[key]
		// 只在概念/实体之间做模糊比对，结构骨架节点不参与
		if !isAlignableKind(entry.Kind) || !isAlignableKind(node.Kind) {
			continue
		}
		labels := append([]string{entry.Name}, entry.Aliases...)
		for _, label := range labels {
			normalizedLabel := NormalizeEntityName(label)
			if normalizedLabel == "" || normalizedLabel == normalizedName {
				continue
			}

			shorter := normalizedName
			longer := normalizedLabel
			if len(normalizedName) > len(normalizedLabel) {
				shorter = normalizedLabel
				longer = normalizedName
			}
			contained := len([]rune(shorter)) >= minContainmentLength && strings.Contains(longer, shorter)
			score := NameSimilarity(normalizedName, normalizedLabel)
			if !contained && score < EntityCandidateThreshold {
				continue
			}

			finalScore := score
			if contained && finalScore < 0.7 {
				finalScore = 0.7
			}
			finalInt := int(finalScore*100 + 0.5)
			if best != nil && best.Score >= finalInt {
				continue
			}
			reason := "name_similar"
			detail := ""
			if contained {
				reason = "name_contains"
				detail = "「" + node.Name + "」与「" + label + "」互为子串"
			} else {
				detail = fmt.Sprintf("「%s」与「%s」名称相似度 %d%%", node.Name, label, finalInt)
			}
			best = &MergeCandidate{
				SourceKey: node.NodeKey,
				TargetKey: entry.CanonicalKey,
				Reason:    reason,
				Score:     finalInt,
				Detail:    detail,
			}
		}
	}

	if best == nil || len(r.candidates) >= maxCandidates {
		return nil
	}
	r.candidates = append(r.candidates, best)
	return best
}

// mergeCandidates 返回累计的合并候选。
func (r *SiteGraphEntityRegistry) mergeCandidates() []*MergeCandidate {
	return r.candidates
}

// topEntries 回喂给后续批次提示词的已知实体清单，按权重取前 N 条。
func (r *SiteGraphEntityRegistry) topEntries(limit int) []EntityRegistryEntry {
	all := make([]EntityRegistryEntry, 0, len(r.keyOrder))
	for _, key := range r.keyOrder {
		all = append(all, *r.byKey[key])
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Weight != all[j].Weight {
			return all[i].Weight > all[j].Weight
		}
		return all[i].Name < all[j].Name
	})
	if len(all) > limit {
		all = all[:limit]
	}
	return all
}

// isAlignableKind 只有概念/实体才需要跨文章对齐。
func isAlignableKind(kind string) bool {
	return kind == NodeKindConcept || kind == NodeKindEntity
}

func dedupeAliases(aliases []string) []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, len(aliases))
	for _, alias := range aliases {
		trimmed := strings.TrimSpace(alias)
		if trimmed == "" {
			continue
		}
		normalized := NormalizeEntityName(trimmed)
		if normalized == "" {
			continue
		}
		if _, dup := seen[normalized]; dup {
			continue
		}
		seen[normalized] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}
