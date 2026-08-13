package kb

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbnode"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
)

const (
	maxArticleTagCount  = 20
	maxArticleTagLength = 80
)

var (
	markdownFenceRE      = regexp.MustCompile("(?s)```.*?```")
	markdownInlineRE     = regexp.MustCompile("`([^`]+)`")
	markdownImageRE      = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	markdownLinkRE       = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	markdownHeadingRE    = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	markdownQuoteRE      = regexp.MustCompile(`(?m)^>\s?`)
	markdownMarksRE      = regexp.MustCompile(`[*_~#>\-]+`)
	articleHeadingLineRE = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*$`)
)

type publicArticleMetadata struct {
	Excerpt        string
	ReadingMinutes int
	TOCJSON        string
	ContentHash    string
}

// PublicArticleMetadata 是文章公开列表与订阅源使用的派生元数据。
type PublicArticleMetadata = publicArticleMetadata

// DerivePublicArticleMetadata 供 Agent 等写入入口复用与站内文章接口一致的元数据算法。
func DerivePublicArticleMetadata(contentMd string) PublicArticleMetadata {
	return derivePublicArticleMetadata(contentMd)
}

type articleTOCItem struct {
	ID    string `json:"id"`
	Level int    `json:"level"`
	Text  string `json:"text"`
}

func normalizeArticleTags(raw []string) ([]string, error) {
	seen := make(map[string]struct{}, len(raw))
	tags := make([]string, 0, len(raw))
	for _, item := range raw {
		tag := strings.TrimSpace(item)
		if tag == "" {
			continue
		}
		if len([]rune(tag)) > maxArticleTagLength {
			return nil, response.BadRequest(fmt.Sprintf("标签长度不能超过 %d", maxArticleTagLength))
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		tags = append(tags, tag)
	}
	if len(tags) > maxArticleTagCount {
		return nil, response.BadRequest(fmt.Sprintf("标签数量不能超过 %d", maxArticleTagCount))
	}
	return tags, nil
}

func (s *Service) loadArticleTags(ctx context.Context, articleID int64) ([]string, error) {
	rows, err := s.client.KBArticleTag.Query().
		Where(kbarticletag.ArticleIDEQ(articleID)).
		Order(ent.Asc(kbarticletag.FieldTag)).
		All(ctx)
	if err != nil {
		return nil, err
	}
	tags := make([]string, 0, len(rows))
	for _, row := range rows {
		tags = append(tags, row.Tag)
	}
	return tags, nil
}

func (s *Service) nextSortOrder(ctx context.Context, userID, knowledgeBaseID int64, parentID *int64) (int, error) {
	query := s.client.KBNode.Query().Where(
		kbnode.UserIDEQ(userID),
		kbnode.KnowledgeBaseIDEQ(knowledgeBaseID),
	)
	if parentID == nil {
		query = query.Where(kbnode.ParentIDIsNil())
	} else {
		query = query.Where(kbnode.ParentIDEQ(*parentID))
	}
	last, err := query.Order(ent.Desc(kbnode.FieldSortOrder), ent.Desc(kbnode.FieldID)).First(ctx)
	if ent.IsNotFound(err) {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	return last.SortOrder + 1, nil
}

func (s *Service) assertFolderParent(ctx context.Context, userID, knowledgeBaseID int64, parentID *int64) error {
	if parentID == nil {
		return nil
	}
	exists, err := s.client.KBNode.Query().Where(
		kbnode.IDEQ(*parentID),
		kbnode.UserIDEQ(userID),
		kbnode.KnowledgeBaseIDEQ(knowledgeBaseID),
		kbnode.TypeEQ("FOLDER"),
	).Exist(ctx)
	if err != nil {
		return err
	}
	if !exists {
		return response.BadRequest("父节点必须是当前知识库下的文件夹")
	}
	return nil
}

func buildKBNodePath(nodes []*ent.KBNode, nodeID int64) (string, error) {
	byID := make(map[int64]*ent.KBNode, len(nodes))
	for _, node := range nodes {
		byID[node.ID] = node
	}
	names := make([]string, 0, 8)
	visited := make(map[int64]struct{})
	current := byID[nodeID]
	for depth := 0; current != nil; depth++ {
		if depth > 100 {
			return "", response.BadRequest("节点路径过深，疑似存在循环引用")
		}
		if _, ok := visited[current.ID]; ok {
			return "", response.BadRequest("节点存在循环引用，无法生成路径")
		}
		visited[current.ID] = struct{}{}
		names = append([]string{current.Name}, names...)
		if current.ParentID == nil {
			break
		}
		current = byID[*current.ParentID]
	}
	if len(names) == 0 {
		return "/", nil
	}
	return "/" + strings.Join(names, "/"), nil
}

func derivePublicArticleMetadata(contentMd string) publicArticleMetadata {
	plain := markdownToPlainText(contentMd)
	excerpt := "暂无摘要"
	if plain != "" {
		runes := []rune(plain)
		if len(runes) > 120 {
			excerpt = strings.TrimSpace(string(runes[:120])) + "..."
		} else {
			excerpt = plain
		}
	}
	cjk, latinWords := 0, 0
	var latin strings.Builder
	for _, r := range plain {
		if unicode.Is(unicode.Han, r) {
			cjk++
			latin.WriteRune(' ')
		} else {
			latin.WriteRune(r)
		}
	}
	latinWords = len(strings.Fields(latin.String()))
	minutes := (cjk + latinWords + 419) / 420
	if minutes < 1 {
		minutes = 1
	}
	toc, _ := json.Marshal(buildArticleTOC(contentMd))
	hash := md5.Sum([]byte(contentMd))
	return publicArticleMetadata{
		Excerpt:        excerpt,
		ReadingMinutes: minutes,
		TOCJSON:        string(toc),
		ContentHash:    hex.EncodeToString(hash[:]),
	}
}

func markdownToPlainText(contentMd string) string {
	text := markdownFenceRE.ReplaceAllString(contentMd, " ")
	text = markdownInlineRE.ReplaceAllString(text, "$1")
	text = markdownImageRE.ReplaceAllString(text, " ")
	text = markdownLinkRE.ReplaceAllString(text, "$1")
	text = markdownHeadingRE.ReplaceAllString(text, "")
	text = markdownQuoteRE.ReplaceAllString(text, "")
	text = markdownMarksRE.ReplaceAllString(text, " ")
	return strings.Join(strings.Fields(text), " ")
}

func buildArticleTOC(contentMd string) []articleTOCItem {
	items := make([]articleTOCItem, 0)
	counts := make(map[string]int)
	inFence := false
	for _, line := range strings.Split(contentMd, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		match := articleHeadingLineRE.FindStringSubmatch(trimmed)
		if len(match) != 3 {
			continue
		}
		text := strings.Join(strings.Fields(match[2]), " ")
		if text == "" {
			continue
		}
		base := githubLikeSlug(text)
		id := base
		if count := counts[base]; count > 0 {
			id = fmt.Sprintf("%s-%d", base, count)
		}
		counts[base]++
		items = append(items, articleTOCItem{ID: id, Level: len(match[1]), Text: text})
	}
	return items
}

func githubLikeSlug(text string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(strings.TrimSpace(text)) {
		switch {
		case unicode.IsLetter(r), unicode.IsDigit(r), r == '_', r == '-':
			b.WriteRune(r)
		case unicode.IsSpace(r):
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

func sortedArticleIDs(rows []*ent.KBArticle) []int64 {
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.ID)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	return ids
}

func articleByID(rows []*ent.KBArticle) map[int64]*ent.KBArticle {
	out := make(map[int64]*ent.KBArticle, len(rows))
	for _, row := range rows {
		out[row.ID] = row
	}
	return out
}

func articleByNodeID(rows []*ent.KBArticle) map[int64]*ent.KBArticle {
	out := make(map[int64]*ent.KBArticle, len(rows))
	for _, row := range rows {
		out[row.NodeID] = row
	}
	return out
}

func (s *Service) loadOwnedArticle(ctx context.Context, userID, articleID int64) (*ent.KBArticle, error) {
	row, err := s.client.KBArticle.Query().Where(
		kbarticle.IDEQ(articleID),
		kbarticle.UserIDEQ(userID),
	).Only(ctx)
	if ent.IsNotFound(err) {
		return nil, response.NotFound("文章不存在")
	}
	return row, err
}
