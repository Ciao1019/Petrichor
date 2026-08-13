package chunker

import "regexp"

// 本文件补齐 WeKnora chunker 包在原仓库中依赖的两个外部符号，
// 让 chunker 保持自包含：移植过来的其余文件与上游逐字一致，便于后续对齐更新。
//
// 上游依赖：
//   - docparser.UnwrapLinkedImages（internal/infrastructure/docparser/image_resolver.go）
//   - logger.Debugf（策略档位被校验器拒绝时的调试日志）

// reLinkedImage 匹配 [![alt](img_url)](link_url) 这种图片被包在链接里的写法。
// 展开成 ![alt](img_url) 之后，下游的图片处理正则只需要处理扁平形式。
// 两个 URL 组都允许一层成对括号。
var reLinkedImage = regexp.MustCompile(
	`\[!\[([^\]]*)\]\(([^()\s]*(?:\([^)]*\)[^()\s]*)*)\)\]` + // [![alt](img_url)]
		`\([^()\s]*(?:\([^)]*\)[^()\s]*)*\)`, // (link_url) —— 匹配但丢弃
)

// unwrapLinkedImages 把正文里所有 [![alt](img_url)](link_url) 展开为 ![alt](img_url)。
func unwrapLinkedImages(markdown string) string {
	return reLinkedImage.ReplaceAllString(markdown, "![$1]($2)")
}

// debugTierRejected 记录某个策略档位被校验器拒绝、策略链继续下探的原因。
// 上游用 logger.Debugf 打日志；这里保留成显式钩子，需要排查分块结果时可以接上日志。
func debugTierRejected(_ StrategyTier, _ string) {}
