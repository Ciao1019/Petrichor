// wiki-guide.go 知识库级「编译说明书」：一页可编辑的 meta 页面，
// 决定这个知识库该抽什么、怎么归类、页面怎么写。
//
// 编译提示词里的输出格式与 JSON 契约仍然写死在代码里；说明书只在其后追加，
// 用来细化领域偏好。没保存过说明书的知识库注入空内容，编译行为与从前完全一致。
package kb

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	// WikiGuidePageKey 编译说明书在 Wiki 里的固定 page key。
	WikiGuidePageKey = "compile-guide"
	wikiGuideKind    = "meta"
	wikiGuideTitle   = "编译说明书"
	// wikiGuideMaxRunes 说明书长度上限：它会进入每一次编译的提示词，不能无限长。
	wikiGuideMaxRunes = 8000
)

// wikiGuideTemplate 首次打开时给用户的起手模板。
// 只有保存之后才会真正参与编译，模板本身不落库。
const wikiGuideTemplate = `# 编译说明书

<!--
这份说明会在编译这个知识库时追加到模型提示里，用来细化「抽什么、怎么归类、页面怎么写」。
它只能细化领域偏好，不能改变系统要求的输出格式；两者冲突时以系统格式为准。
只有你自己写下的内容会进入提示词：HTML 注释、以及只有标题没有内容的小节都会被自动剔除。
整页留空即完全不生效，编译行为与从前一致。
-->

## 领域与读者

<!-- 例：这是一个 macOS 命令行工具的使用文档库，读者是有终端基础的开发者。 -->

## 抽取偏好

<!-- 例：
- 命令、子命令和配置项都抽成 concept，不要抽成 entity。
- 版本号、发布日期不单独建页。
-->

## 目录约定

<!-- 例：一级目录固定用「安装」「日常使用」「进阶配置」「故障排查」。 -->

## 页面写法

<!-- 例：
- 每页开头先给一句话定义，再给最小可用示例。
- 命令一律用代码块，并标注需要的权限。
-->

## 术语表

<!-- 例：统一使用「知识库」而不是「文档库」。 -->
`

// compileProfile 一次知识编译共享的上下文：知识库名 + 该库的编译说明书。
type compileProfile struct {
	KnowledgeBaseName string
	Guide             string
}

// htmlCommentRe Markdown 里的 HTML 注释。模板用注释承载示例，
// 注入提示词前统一剥掉，避免示例被模型当成真实规则。
var htmlCommentRe = regexp.MustCompile(`(?s)<!--.*?-->`)

// leadingH1Re 页面首行标题只是给人看的，不必进提示词。
var leadingH1Re = regexp.MustCompile(`\A\s*#\s+[^\n]*\n?`)

// normalizeGuideForPrompt 把说明书正文压成可注入的纯规则文本。
func normalizeGuideForPrompt(contentMd string) string {
	text := htmlCommentRe.ReplaceAllString(contentMd, "")
	text = leadingH1Re.ReplaceAllString(text, "")
	// 去掉只剩标题、没有内容的空小节，避免注入一堆空壳标题。
	var kept []string
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") && !sectionHasBody(lines[i+1:]) {
			continue
		}
		kept = append(kept, line)
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

// sectionHasBody 判断标题之后、下一个标题之前还有没有实质内容。
func sectionHasBody(rest []string) bool {
	for _, line := range rest {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "#") {
			return false
		}
		return true
	}
	return false
}

// guidePromptLines 说明书作为系统提示的补充段落；未配置时返回 nil。
// 明确声明优先级，防止自然语言写的偏好把上面的 JSON 输出契约冲掉。
func (p compileProfile) guidePromptLines() []string {
	guide := normalizeGuideForPrompt(p.Guide)
	if guide == "" {
		return nil
	}
	return []string{
		"以下是这个知识库的编译约定，请在不违反上述输出格式要求的前提下遵循；两者冲突时以上述格式要求为准。",
		"<compile_guide>",
		guide,
		"</compile_guide>",
	}
}

// systemPrompt 基础规则 + 说明书，组成最终 system prompt。
func (p compileProfile) systemPrompt(baseLines ...string) string {
	return strings.Join(append(baseLines, p.guidePromptLines()...), "\n")
}

// loadCompileProfile 读取知识库名与说明书；说明书不存在返回空 Guide。
func loadCompileProfile(ctx context.Context, q execQuerier, userID int64, kbRow *KBRow) compileProfile {
	profile := compileProfile{KnowledgeBaseName: kbRow.Name}
	page, err := loadWikiPage(ctx, q, userID, kbRow.ID, WikiGuidePageKey)
	if err != nil || page == nil || page.ArchivedAt != nil {
		return profile
	}
	profile.Guide = page.ContentMd
	return profile
}

// ===== 端点 =====

// WikiGuideDetail POST /api/kb/wiki/guide：读取编译说明书。
// 没保存过时返回 enabled=false 与起手模板，不落库。
func WikiGuideDetail(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}
		page, err := loadWikiPage(c.Request.Context(), q, user.ID, kbID, WikiGuidePageKey)
		if err != nil {
			return nil, err
		}
		enabled := page != nil && page.ArchivedAt == nil
		contentMd := ""
		var updatedAt any
		if enabled {
			contentMd = page.ContentMd
			updatedAt = iso(page.UpdatedAt)
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"pageKey":         WikiGuidePageKey,
			"title":           wikiGuideTitle,
			"enabled":         enabled,
			"contentMd":       contentMd,
			"templateMd":      wikiGuideTemplate,
			"maxLength":       wikiGuideMaxRunes,
			"updatedAt":       updatedAt,
		}, nil
	})
}

// WikiGuideSave POST /api/kb/wiki/guide/save：保存或清空编译说明书。
// 内容为空表示停用：删除该页面，后续编译回到默认行为。
func WikiGuideSave(c *ginContext) {
	run(c, func(c *ginContext) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		contentMd := strings.TrimSpace(toStr(raw["contentMd"]))
		if len([]rune(contentMd)) > wikiGuideMaxRunes {
			return nil, badReq("编译说明书不能超过 " + strconvItoa(wikiGuideMaxRunes) + " 个字符")
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(c.Request.Context(), q, user.ID, kbID); err != nil {
			return nil, err
		}

		if contentMd == "" {
			removed, derr := deleteWikiPageByKey(c.Request.Context(), q, user.ID, kbID, WikiGuidePageKey)
			if derr != nil {
				return nil, derr
			}
			if removed {
				if err := logWikiEvent(c.Request.Context(), q, user.ID, kbID, "WIKI_GUIDE_CLEARED", nil, nil); err != nil {
					return nil, err
				}
			}
			return map[string]any{
				"knowledgeBaseId": strconv.FormatInt(kbID, 10),
				"pageKey":         WikiGuidePageKey,
				"enabled":         false,
				"contentMd":       "",
			}, nil
		}

		now := time.Now()
		page, err := upsertWikiPage(c.Request.Context(), q, upsertWikiPageInput{
			UserID: user.ID, KnowledgeBaseID: kbID,
			PageKey: WikiGuidePageKey, Title: wikiGuideTitle, Kind: wikiGuideKind,
			ContentMd: contentMd, Summary: strPtr("这个知识库的编译约定，会追加到每次编译的提示词里"),
			Frontmatter:    map[string]any{"generatedBy": "wiki-guide", "okfStatus": "stable"},
			HasFrontmatter: true,
			Now:            now,
		})
		if err != nil {
			return nil, err
		}
		if err := logWikiEvent(c.Request.Context(), q, user.ID, kbID, "WIKI_GUIDE_SAVED", &page.ID,
			map[string]any{"length": len([]rune(contentMd))}); err != nil {
			return nil, err
		}
		return map[string]any{
			"knowledgeBaseId": strconv.FormatInt(kbID, 10),
			"pageKey":         WikiGuidePageKey,
			"title":           wikiGuideTitle,
			"enabled":         true,
			"contentMd":       page.ContentMd,
			"updatedAt":       iso(page.UpdatedAt),
		}, nil
	})
}
