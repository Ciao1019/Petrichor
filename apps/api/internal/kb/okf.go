// okf.go 把 Wiki 页面映射到 Google Open Knowledge Format（OKF v0.2）：
// 页面 kind → OKF type、source_ref → sources、构建元数据 → generated / status。
// 规范见 https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
//
// OKF 只强制 type 一个字段，其余均为推荐字段，并要求消费者容忍未知字段；
// 因此 Petrichor 自己的构建元数据统一挂在 x_petrichor 命名空间下，
// 既不污染标准字段，也让导出的 bundle 具备重新导入所需的全部信息。
package kb

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"petrichor/api/internal/config"
)

// OKFVersion 导出 bundle 声明的目标规范版本。
const OKFVersion = "0.2"

// 导出格式：okf 用 bundle 绝对路径的标准 Markdown 链接（规范推荐，跨目录稳定），
// obsidian 原样保留 [[wikilink]]，直接当 Obsidian vault 打开。
const (
	OKFFormatOKF      = "okf"
	OKFFormatObsidian = "obsidian"
)

// OKF status 取值。
const (
	okfStatusDraft      = "draft"
	okfStatusStable     = "stable"
	okfStatusDeprecated = "deprecated"
)

// okfReservedRootNames OKF 在 bundle 根保留的文件名，普通页面不得占用。
var okfReservedRootNames = map[string]struct{}{"index": {}, "log": {}}

// okfKindProfile 页面 kind 在 bundle 内的落点与对应 OKF type。
type okfKindProfile struct {
	dir     string
	okfType string
}

// okfKindProfiles kind=index 由导出器单独生成根 index.md，不作为普通页面落盘。
// kind=log 落在 logs/ 子目录，不会和 OKF 保留的根 log.md 冲突。
var okfKindProfiles = map[string]okfKindProfile{
	"source":     {dir: "sources", okfType: "Source Document"},
	"concept":    {dir: "concepts", okfType: "Concept"},
	"entity":     {dir: "entities", okfType: "Entity"},
	"comparison": {dir: "comparisons", okfType: "Comparison"},
	"answer":     {dir: "answers", okfType: "Answer"},
	"log":        {dir: "logs", okfType: "Log"},
	"meta":       {dir: "guides", okfType: "Guide"},
}

// okfProfileForKind 未知 kind 落到 pages/ 并原样保留 kind 作为 type；
// OKF 不集中注册 type 取值，消费者本来就要容忍未知类型。
func okfProfileForKind(kind string) okfKindProfile {
	if profile, ok := okfKindProfiles[kind]; ok {
		return profile
	}
	return okfKindProfile{dir: "pages", okfType: kind}
}

// okfUnsafeFileChars 文件名白名单之外的字符一律折叠成连字符。
// page_key 入库前已过 normalizePageKey，这里只是对存量脏数据再兜一层，
// 顺带阻断 ../ 之类的路径穿越。
var okfUnsafeFileChars = regexp.MustCompile(`[^a-z0-9\p{Han}._-]+`)

func okfSafeFileName(raw string) string {
	name := okfUnsafeFileChars.ReplaceAllString(strings.ToLower(strings.TrimSpace(raw)), "-")
	name = strings.Trim(name, "-._")
	if name == "" {
		return "page"
	}
	if runes := []rune(name); len(runes) > 120 {
		name = string(runes[:120])
	}
	if _, reserved := okfReservedRootNames[name]; reserved {
		name = "page-" + name
	}
	return name
}

// okfPagePath 页面在 bundle 内的相对路径。
func okfPagePath(kind, pageKey string) string {
	name := okfSafeFileName(pageKey) + ".md"
	if dir := okfProfileForKind(kind).dir; dir != "" {
		return dir + "/" + name
	}
	return name
}

// ===== frontmatter =====

type okfGenerated struct {
	By string `yaml:"by"`
	At string `yaml:"at"`
}

type okfSource struct {
	Resource     string `yaml:"resource"`
	Title        string `yaml:"title,omitempty"`
	LastModified string `yaml:"last_modified,omitempty"`
	Note         string `yaml:"note,omitempty"`
}

// okfPetrichorExt Petrichor 私有扩展，保证 bundle 可无损回流。
type okfPetrichorExt struct {
	PageKey         string `yaml:"page_key"`
	Kind            string `yaml:"kind"`
	KnowledgeBaseID string `yaml:"knowledge_base_id"`
	Version         int32  `yaml:"version"`
	ContentHash     string `yaml:"content_hash"`
	BuildVersion    int    `yaml:"build_version,omitempty"`
	SourceHash      string `yaml:"source_hash,omitempty"`
	UpdatedAt       string `yaml:"updated_at"`
}

// okfFrontmatter 字段顺序即 YAML 输出顺序，按「是什么 → 怎么找 → 可信度」排列。
type okfFrontmatter struct {
	Type        string           `yaml:"type"`
	Title       string           `yaml:"title,omitempty"`
	Description string           `yaml:"description,omitempty"`
	Tags        []string         `yaml:"tags,omitempty"`
	Status      string           `yaml:"status,omitempty"`
	StaleAfter  string           `yaml:"stale_after,omitempty"`
	Generated   *okfGenerated    `yaml:"generated,omitempty"`
	Sources     []okfSource      `yaml:"sources,omitempty"`
	Petrichor   *okfPetrichorExt `yaml:"x_petrichor,omitempty"`
}

// okfPageInput 组装单页 frontmatter 所需的全部输入；Articles 允许缺项，
// 缺失时只写 resource，不编造标题和时间。
type okfPageInput struct {
	Page     *WikiPageRow
	Refs     []SourceRefRow
	Articles map[int64]*ArticleRow
	// StaleSince 源文档在这页编译之后的最新更新时间；非空即写成 OKF stale_after，
	// 让消费者一眼看出这页已经落后于原文。
	StaleSince *time.Time
}

// configBaseURL 站点公开地址，供 kb 包内各处拼绝对链接。
func configBaseURL() string { return config.Get().BaseURL }

// articleResourceURI 源文章的稳定 URI；BaseURL 未配置时回落站内绝对路径。
func articleResourceURI(knowledgeBaseID, articleID int64) string {
	path := "/dashboard/knowledge/" + strconv.FormatInt(knowledgeBaseID, 10) +
		"/articles/" + strconv.FormatInt(articleID, 10)
	if base := strings.TrimRight(strings.TrimSpace(config.Get().BaseURL), "/"); base != "" {
		return base + path
	}
	return path
}

// buildOKFFrontmatter 由页面行、来源引用和构建元数据推导 OKF frontmatter。
func buildOKFFrontmatter(in okfPageInput) okfFrontmatter {
	page := in.Page
	metadata := readKnowledgePageMetadata(page.FrontmatterJson)
	// readKnowledgePageMetadata 只认识构建流程写入的固定字段，
	// OKF 扩展字段（staleAfter / status 覆写）直接从原始 frontmatter 读。
	raw := parseJSONObject(page.FrontmatterJson)

	fm := okfFrontmatter{
		Type:        okfProfileForKind(page.Kind).okfType,
		Title:       page.Title,
		Description: derefOrSummarize(page.Summary, page.ContentMd, 200),
		Tags:        okfTags(metadata),
		Status:      okfStatus(page, in.Refs),
		Generated: &okfGenerated{
			By: okfGeneratedBy(metadata),
			At: iso(page.UpdatedAt),
		},
		Sources: okfSources(page.KnowledgeBaseID, in.Refs, in.Articles),
		Petrichor: &okfPetrichorExt{
			PageKey:         page.PageKey,
			Kind:            page.Kind,
			KnowledgeBaseID: strconv.FormatInt(page.KnowledgeBaseID, 10),
			Version:         page.Version,
			ContentHash:     page.ContentHash,
			BuildVersion:    int(optNumber(metadata["buildVersion"])),
			SourceHash:      toStr(metadata["sourceHash"]),
			UpdatedAt:       iso(page.UpdatedAt),
		},
	}
	if in.StaleSince != nil {
		fm.StaleAfter = iso(*in.StaleSince)
	}
	if stale := strings.TrimSpace(optString(raw["staleAfter"])); stale != "" {
		fm.StaleAfter = stale
	}
	if status := strings.TrimSpace(optString(raw["okfStatus"])); status != "" {
		fm.Status = status
	}
	return fm
}

// okfTags 分类路径与别名合并去重，作为 OKF tags。
func okfTags(metadata map[string]any) []string {
	seen := map[string]struct{}{}
	var tags []string
	for _, key := range []string{"categoryPath", "aliases"} {
		values, _ := metadata[key].([]string)
		for _, value := range values {
			tag := strings.TrimSpace(value)
			if tag == "" {
				continue
			}
			if _, ok := seen[tag]; ok {
				continue
			}
			seen[tag] = struct{}{}
			tags = append(tags, tag)
		}
	}
	if len(tags) > 16 {
		tags = tags[:16]
	}
	return tags
}

// okfStatus 归档页面标记 deprecated；没有任何来源引用的页面只能算 draft。
func okfStatus(page *WikiPageRow, refs []SourceRefRow) string {
	if page.ArchivedAt != nil {
		return okfStatusDeprecated
	}
	if len(refs) == 0 && page.Kind != "index" && page.Kind != "meta" {
		return okfStatusDraft
	}
	return okfStatusStable
}

func okfGeneratedBy(metadata map[string]any) string {
	if by := strings.TrimSpace(toStr(metadata["generatedBy"])); by != "" {
		return "petrichor/" + by
	}
	return "petrichor"
}

// okfSources source_ref → OKF sources，按 article id 稳定排序。
func okfSources(knowledgeBaseID int64, refs []SourceRefRow, articles map[int64]*ArticleRow) []okfSource {
	if len(refs) == 0 {
		return nil
	}
	ordered := append([]SourceRefRow(nil), refs...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ArticleID < ordered[j].ArticleID })

	seen := map[int64]struct{}{}
	sources := make([]okfSource, 0, len(ordered))
	for i := range ordered {
		ref := &ordered[i]
		if _, ok := seen[ref.ArticleID]; ok {
			continue
		}
		seen[ref.ArticleID] = struct{}{}
		source := okfSource{
			Resource: articleResourceURI(knowledgeBaseID, ref.ArticleID),
			Note:     derefStr(ref.Note),
		}
		if article, ok := articles[ref.ArticleID]; ok && article != nil {
			source.Title = article.Title
			source.LastModified = iso(article.UpdatedAt)
		}
		sources = append(sources, source)
	}
	return sources
}

// ===== 渲染 =====

// renderOKFDocument 渲染单个 OKF 文件：YAML frontmatter + Markdown 正文。
func renderOKFDocument(frontmatter any, body string) (string, error) {
	raw, err := yaml.Marshal(frontmatter)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	b.WriteString("---\n")
	b.Write(raw)
	if !strings.HasSuffix(string(raw), "\n") {
		b.WriteString("\n")
	}
	b.WriteString("---\n\n")
	b.WriteString(strings.TrimSpace(body))
	b.WriteString("\n")
	return b.String(), nil
}

// wikiLinkPattern 匹配 [[page-key]] 与 [[page-key|Label]]。
// 标签部分只排除竖线和换行：实体名里出现方括号（如「GPT-4 [Turbo]」）时
// 仍要能整体匹配，非贪婪保证遇到最近的 ]] 就收尾，不会跨链接吞并。
var wikiLinkPattern = regexp.MustCompile(`\[\[([^\[\]|\n]+?)(?:\|([^|\n]*?))?\]\]`)

// markdownLabelEscaper 链接标签里的方括号会截断 Markdown 链接语法。
var markdownLabelEscaper = strings.NewReplacer("[", `\[`, "]", `\]`)

// convertWikiLinks 按导出格式改写正文里的 wikilink。
// 解析不到的 page key 保持原文：断链信息交给 wiki lint 暴露，导出阶段不静默吞掉。
func convertWikiLinks(content, format string, pathByKey map[string]string) string {
	if format != OKFFormatOKF {
		return content
	}
	return wikiLinkPattern.ReplaceAllStringFunc(content, func(match string) string {
		groups := wikiLinkPattern.FindStringSubmatch(match)
		if len(groups) < 3 {
			return match
		}
		path, ok := pathByKey[normalizePageKey(groups[1])]
		if !ok {
			return match
		}
		label := strings.TrimSpace(groups[2])
		if label == "" {
			label = strings.TrimSpace(groups[1])
		}
		return "[" + markdownLabelEscaper.Replace(label) + "](/" + path + ")"
	})
}
