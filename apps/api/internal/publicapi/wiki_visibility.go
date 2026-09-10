package publicapi

import (
	"context"
	"net/url"
	"regexp"
	"strings"
)

type publicWikiTargets map[string]bool

func loadPublicWikiTargets(ctx context.Context, ids []int64) (publicWikiTargets, error) {
	rows, err := pool().Query(ctx, `SELECT knowledge_base_id, page_key
		FROM petrichor_kb_wiki_page WHERE id = ANY($1)`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := publicWikiTargets{}
	for rows.Next() {
		var kbID int64
		var key string
		if err := rows.Scan(&kbID, &key); err != nil {
			return nil, err
		}
		targets[publicWikiPageHref(kbID, key)] = true
	}
	return targets, rows.Err()
}

var publicWikiReference = regexp.MustCompile(`\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\((#[Ww]iki-page=[^\s)]+|/wiki/[^\s)]+)(?:\s+"[^"]*")?\)`)

// 邻接列表过滤并不能清除正文里存量的私有链接；连同其别名一起移除，
// 避免公开端泄露私有页的标题或 pageKey。普通外链和其余正文不受影响。
func sanitizePublicWikiReferences(content string, kbID int64, targets publicWikiTargets) string {
	return publicWikiReference.ReplaceAllStringFunc(content, func(raw string) string {
		parts := publicWikiReference.FindStringSubmatch(raw)
		href := parts[2]
		if parts[1] != "" {
			href = publicWikiPageHref(kbID, strings.TrimSpace(parts[1]))
		} else if strings.HasPrefix(strings.ToLower(href), "#wiki-page=") {
			key, err := url.PathUnescape(href[len("#wiki-page="):])
			if err != nil {
				return "（未公开知识页）"
			}
			href = publicWikiPageHref(kbID, key)
		}
		if !targets[href] {
			return "（未公开知识页）"
		}
		return raw
	})
}

func sanitizePublicWikiPage(page *wikiPageRecord, targets publicWikiTargets) {
	page.contentMd = sanitizePublicWikiReferences(page.contentMd, page.knowledgeBaseID, targets)
	if page.summary != nil {
		summary := sanitizePublicWikiReferences(*page.summary, page.knowledgeBaseID, targets)
		page.summary = &summary
	}
}
