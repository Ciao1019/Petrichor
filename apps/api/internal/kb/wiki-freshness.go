// wiki-freshness.go Wiki 新鲜度判定：源文档改过、或编译流程本身升级过之后，
// 哪些页面需要重新编译。lint 用它给出待处理问题，OKF 导出用它写 stale_after。
//
// 判定优先用精确指纹：source 页面的 frontmatter 存了编译时的 sourceHash，
// 与源文章当前内容重新哈希后比对即可确定文章是否变过；概念、实体等派生页面
// 没有自己的指纹，直接沿用它们所引用文章的判定结果。只有当某篇文章根本没有
// source 页面（存量数据）时才退回「文章更新时间晚于页面更新时间」的近似比较。
package kb

import (
	"strconv"
	"strings"
	"time"
)

// Wiki 新鲜度问题码。
const (
	wikiIssueStaleSource  = "stale_source"
	wikiIssueOutdatedBuil = "outdated_build"
)

// wikiStaleReason 单个页面失效的原因。
type wikiStaleReason struct {
	Code    string
	Message string
	// StaleSince 失效起点：源文档最后一次更新的时间。
	// 导出成 OKF 时写进 stale_after —— 该时刻之后这页就不再可信。
	StaleSince *time.Time
}

// wikiFreshness 一次新鲜度评估的结果。
type wikiFreshness struct {
	// ReasonsByPage key 是 wiki page id。
	ReasonsByPage map[int64][]wikiStaleReason
	// StalePageCount 至少命中一条失效原因的页面数。
	StalePageCount int
}

// articleFingerprint 源文章当前内容指纹，与 wiki-build.go 写入 frontmatter 的算法一致。
func articleFingerprint(article *ArticleRow) string {
	return sha256Hex(article.Title + "\n" + article.ContentMd)
}

// evaluateWikiFreshness 逐页给出失效原因。articles 允许缺项，缺失的文章不参与判定
// （只可能是引用了已删除的文章，那属于 lint 的另一类问题）。
func evaluateWikiFreshness(
	pages []WikiPageRow,
	refsByPage map[int64][]SourceRefRow,
	articles map[int64]*ArticleRow,
) wikiFreshness {
	changedArticles := detectChangedArticles(pages, articles)

	result := wikiFreshness{ReasonsByPage: map[int64][]wikiStaleReason{}}
	for i := range pages {
		page := &pages[i]
		var reasons []wikiStaleReason

		if reason := staleSourceReason(page, refsByPage[page.ID], articles, changedArticles); reason != nil {
			reasons = append(reasons, *reason)
		}
		if reason := outdatedBuildReason(page); reason != nil {
			reasons = append(reasons, *reason)
		}
		if len(reasons) > 0 {
			result.ReasonsByPage[page.ID] = reasons
			result.StalePageCount++
		}
	}
	return result
}

// detectChangedArticles 用 source 页面的指纹判定哪些文章在编译之后被改过。
// 返回值只收录能拿到精确结论的文章；没有 source 页面的文章不会出现在里面。
func detectChangedArticles(pages []WikiPageRow, articles map[int64]*ArticleRow) map[int64]bool {
	changed := map[int64]bool{}
	for i := range pages {
		page := &pages[i]
		if page.Kind != "source" {
			continue
		}
		articleID, ok := parseSourcePageKey(page.PageKey)
		if !ok {
			continue
		}
		article, ok := articles[articleID]
		if !ok || article == nil {
			continue
		}
		stored := strings.TrimSpace(optString(parseJSONObject(page.FrontmatterJson)["sourceHash"]))
		if stored == "" {
			continue
		}
		changed[articleID] = stored != articleFingerprint(article)
	}
	return changed
}

// staleSourceReason 页面引用的任一源文档在编译之后变过就算失效，
// StaleSince 取这些文档里最新的一次更新时间。
func staleSourceReason(
	page *WikiPageRow,
	refs []SourceRefRow,
	articles map[int64]*ArticleRow,
	changedArticles map[int64]bool,
) *wikiStaleReason {
	var staleSince *time.Time
	staleCount := 0
	for i := range refs {
		article, ok := articles[refs[i].ArticleID]
		if !ok || article == nil {
			continue
		}
		stale, decided := changedArticles[article.ID]
		if !decided {
			// 存量数据没有 source 页面指纹，退回时间比较。
			stale = article.UpdatedAt.After(page.UpdatedAt)
		}
		if !stale {
			continue
		}
		staleCount++
		if staleSince == nil || article.UpdatedAt.After(*staleSince) {
			updatedAt := article.UpdatedAt
			staleSince = &updatedAt
		}
	}
	if staleCount == 0 {
		return nil
	}
	message := "源文档在这页编译之后有更新，建议重新编译"
	if staleCount > 1 {
		message = "有 " + strconv.Itoa(staleCount) + " 篇源文档在这页编译之后有更新，建议重新编译"
	}
	return &wikiStaleReason{Code: wikiIssueStaleSource, Message: message, StaleSince: staleSince}
}

// outdatedBuildReason 页面由更老的编译流程产出时提示重编译。
// buildVersion 为 0 表示不是 LLM 编译产物（手工页 / 索引页），不参与判定。
func outdatedBuildReason(page *WikiPageRow) *wikiStaleReason {
	raw := parseJSONObject(page.FrontmatterJson)
	buildVersion := int(optNumber(raw["buildVersion"]))
	if buildVersion <= 0 {
		return nil
	}
	if buildVersion < ArticleKnowledgeBuildVersion {
		return &wikiStaleReason{
			Code: wikiIssueOutdatedBuil,
			Message: "由第 " + strconv.Itoa(buildVersion) + " 版编译流程产出，当前已是第 " +
				strconv.Itoa(ArticleKnowledgeBuildVersion) + " 版，建议重新编译",
		}
	}
	if chunkVersion := int(optNumber(raw["chunkAlgorithmVersion"])); chunkVersion > 0 &&
		chunkVersion < ChunkAlgorithmVersion {
		return &wikiStaleReason{
			Code: wikiIssueOutdatedBuil,
			Message: "分片算法已升级到第 " + strconv.Itoa(ChunkAlgorithmVersion) +
				" 版，这页仍是第 " + strconv.Itoa(chunkVersion) + " 版，建议重新编译",
		}
	}
	return nil
}
