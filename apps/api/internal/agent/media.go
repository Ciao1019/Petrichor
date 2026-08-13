package agent

import (
	"context"
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/internal/upload"
)

type agentMediaReference struct {
	ID                 string  `json:"id"`
	Kind               string  `json:"kind"`
	Alt                string  `json:"alt"`
	Src                string  `json:"src"`
	ObjectKey          *string `json:"objectKey"`
	Filename           string  `json:"filename"`
	SourceArticleID    *string `json:"sourceArticleId,omitempty"`
	SourceArticleTitle *string `json:"sourceArticleTitle,omitempty"`
}

var (
	agentMarkdownMediaRE = regexp.MustCompile(`!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)`)
	agentHTMLMediaDblRE  = regexp.MustCompile(`(?i)<(?:img|video|audio|source|file)\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>`)
	agentHTMLMediaSglRE  = regexp.MustCompile(`(?i)<(?:img|video|audio|source|file)\b[^>]*\bsrc\s*=\s*'([^']+)'[^>]*>`)
	agentHTMLAnchorDblRE = regexp.MustCompile(`(?i)<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>`)
	agentHTMLAnchorSglRE = regexp.MustCompile(`(?i)<a\b[^>]*\bhref\s*=\s*'([^']+)'[^>]*>`)
	agentRawStorageRE    = regexp.MustCompile(`(?i)(?:s4key:)?/?uploads/\d+/[^\s"'<>()[\]{}]+?\.[a-z0-9]{1,12}(?:[?#][^\s"'<>()[\]{}]*)?`)
	agentS4ReferenceRE   = regexp.MustCompile(`s4key:([^\s"'<>),\]}]+)`)
)

func (h *Handler) readAgentWikiDocument(ctx context.Context, userID, knowledgeBaseID int64, pageKey string) (gin.H, error) {
	detail, err := h.kbSvc.LoadWikiPageDetailForAgent(ctx, userID, knowledgeBaseID, pageKey)
	if err != nil {
		return nil, err
	}
	normalizedPageKey, _ := detail["pageKey"].(string)
	contentMd, _ := detail["contentMd"].(string)
	title, _ := detail["title"].(string)
	kind, _ := detail["kind"].(string)
	media := extractAgentMediaReferences(contentMd, nil, nil)
	media = mergeAgentMediaReferences(media)
	return gin.H{
		"type": "wiki", "knowledgeBaseId": fmt.Sprintf("%d", knowledgeBaseID),
		"pageKey": normalizedPageKey, "articleId": nil, "href": fmt.Sprintf("/dashboard/knowledge/%d", knowledgeBaseID),
		"title": title, "kind": kind, "contentMd": contentMd, "media": media,
		"documentRefs": detail["documentRefs"], "links": detail["links"],
	}, nil
}

func extractAgentStorageObjectKeys(contentMd string, contentJSON *string, userID int64) []string {
	prefix := fmt.Sprintf("uploads/%d/", userID)
	seen := make(map[string]bool)
	out := make([]string, 0)
	collect := func(value string) {
		for _, match := range agentS4ReferenceRE.FindAllStringSubmatch(value, -1) {
			key := strings.TrimLeft(strings.TrimSpace(match[1]), "/")
			if strings.HasPrefix(key, prefix) && !seen[key] {
				seen[key] = true
				out = append(out, key)
			}
		}
	}
	collect(contentMd)
	if contentJSON != nil {
		collect(*contentJSON)
	}
	return out
}

func agentStringSetDifference(left, right []string) []string {
	rightSet := make(map[string]bool, len(right))
	for _, value := range right {
		rightSet[value] = true
	}
	out := make([]string, 0)
	for _, value := range left {
		if !rightSet[value] {
			out = append(out, value)
		}
	}
	return out
}

func (h *Handler) scheduleAgentStorageCleanup(userID int64, candidates []string) {
	if len(candidates) == 0 || h.cfg == nil || (strings.TrimSpace(h.cfg.LocalStorageDir) == "" && h.cfg.S3 == nil) {
		return
	}
	keys := append([]string(nil), candidates...)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		rows, err := h.client.KBArticle.Query().Where(kbarticle.UserIDEQ(userID)).All(ctx)
		if err != nil {
			return
		}
		referenced := make(map[string]bool)
		for _, row := range rows {
			for _, key := range extractAgentStorageObjectKeys(row.ContentMd, row.ContentJSON, userID) {
				referenced[key] = true
			}
		}
		seen := make(map[string]bool)
		for _, key := range keys {
			if seen[key] || referenced[key] {
				continue
			}
			seen[key] = true
			_ = upload.DeleteObject(ctx, h.cfg, key)
		}
	}()
}

func extractAgentMediaReferences(markdown string, sourceArticleID, sourceArticleTitle *string) []agentMediaReference {
	if strings.TrimSpace(markdown) == "" {
		return []agentMediaReference{}
	}
	refs := make([]agentMediaReference, 0)
	seen := make(map[string]bool)
	counters := map[string]int{"image": 0, "video": 0, "audio": 0, "file": 0}
	add := func(rawSource, label, explicitFilename string) {
		ref, ok := normalizeAgentMediaReference(rawSource)
		if !ok {
			return
		}
		key := ref.Src
		if ref.ObjectKey != nil {
			key = *ref.ObjectKey
		}
		if seen[key] || len(refs) >= 20 {
			return
		}
		seen[key] = true
		if strings.TrimSpace(explicitFilename) != "" {
			ref.Filename = strings.TrimSpace(explicitFilename)
		}
		if strings.TrimSpace(label) != "" {
			ref.Alt = strings.TrimSpace(label)
		} else if ref.Alt == "" {
			ref.Alt = ref.Filename
		}
		counters[ref.Kind]++
		ref.ID = fmt.Sprintf("%s-%d", ref.Kind, counters[ref.Kind])
		ref.SourceArticleID = sourceArticleID
		ref.SourceArticleTitle = sourceArticleTitle
		refs = append(refs, ref)
	}
	for _, match := range agentMarkdownMediaRE.FindAllStringSubmatch(markdown, -1) {
		add(match[2], match[1], "")
	}
	for _, pattern := range []*regexp.Regexp{agentHTMLMediaDblRE, agentHTMLMediaSglRE, agentHTMLAnchorDblRE, agentHTMLAnchorSglRE} {
		for _, match := range pattern.FindAllStringSubmatch(markdown, -1) {
			add(match[1], "", "")
		}
	}
	for _, match := range agentRawStorageRE.FindAllString(markdown, -1) {
		add(match, "", "")
	}
	return refs
}

func normalizeAgentMediaReference(rawSource string) (agentMediaReference, bool) {
	source := strings.Trim(strings.TrimSpace(rawSource), "<>")
	if source == "" {
		return agentMediaReference{}, false
	}
	withoutPrefix := strings.TrimPrefix(source, "s4key:")
	objectKey := strings.TrimLeft(strings.SplitN(strings.SplitN(withoutPrefix, "?", 2)[0], "#", 2)[0], "/")
	if matched, _ := regexp.MatchString(`(?i)^uploads/\d+/.+`, objectKey); matched {
		kind := classifyAgentMediaKind(objectKey)
		if kind == "" {
			kind = "file"
		}
		canonical := "s4key:" + objectKey
		return agentMediaReference{Kind: kind, Src: canonical, ObjectKey: &objectKey, Filename: agentMediaFilename(objectKey), Alt: agentMediaFilename(objectKey)}, true
	}
	if strings.HasPrefix(strings.ToLower(source), "data:image/") {
		return agentMediaReference{Kind: "image", Src: source, Filename: "图片", Alt: "图片"}, true
	}
	parsed, err := url.Parse(source)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return agentMediaReference{}, false
	}
	kind := classifyAgentMediaKind(parsed.Path)
	if kind == "" {
		return agentMediaReference{}, false
	}
	filename := agentMediaFilename(parsed.Path)
	return agentMediaReference{Kind: kind, Src: source, Filename: filename, Alt: filename}, true
}

func classifyAgentMediaKind(value string) string {
	extension := strings.ToLower(path.Ext(strings.SplitN(strings.SplitN(value, "?", 2)[0], "#", 2)[0]))
	switch extension {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp":
		return "image"
	case ".mp4", ".webm", ".ogv", ".mov", ".m4v", ".mkv":
		return "video"
	case ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".oga":
		return "audio"
	case ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".txt", ".md", ".zip", ".rar", ".7z", ".json":
		return "file"
	default:
		return ""
	}
}

func agentMediaFilename(value string) string {
	clean := strings.SplitN(strings.SplitN(value, "?", 2)[0], "#", 2)[0]
	filename := path.Base(clean)
	if filename == "." || filename == "/" || filename == "" {
		return "附件"
	}
	if decoded, err := url.PathUnescape(filename); err == nil {
		return decoded
	}
	return filename
}

func mergeAgentMediaReferences(refs []agentMediaReference) []agentMediaReference {
	out := make([]agentMediaReference, 0, min(20, len(refs)))
	seen := make(map[string]bool)
	counters := map[string]int{"image": 0, "video": 0, "audio": 0, "file": 0}
	for _, ref := range refs {
		key := ref.Src
		if ref.ObjectKey != nil {
			key = *ref.ObjectKey
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		counters[ref.Kind]++
		ref.ID = fmt.Sprintf("%s-%d", ref.Kind, counters[ref.Kind])
		out = append(out, ref)
		if len(out) >= 20 {
			break
		}
	}
	return out
}
