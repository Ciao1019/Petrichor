package publicqa

import (
	"fmt"
	"net/url"
	"path"
	"regexp"
	"strings"
)

type publicMediaReference struct {
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
	publicMarkdownMediaRE = regexp.MustCompile(`!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)`)
	publicHTMLMediaDblRE  = regexp.MustCompile(`(?i)<(?:img|video|audio|source|file)\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>`)
	publicHTMLMediaSglRE  = regexp.MustCompile(`(?i)<(?:img|video|audio|source|file)\b[^>]*\bsrc\s*=\s*'([^']+)'[^>]*>`)
	publicHTMLAnchorDblRE = regexp.MustCompile(`(?i)<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>`)
	publicHTMLAnchorSglRE = regexp.MustCompile(`(?i)<a\b[^>]*\bhref\s*=\s*'([^']+)'[^>]*>`)
	publicRawStorageRE    = regexp.MustCompile(`(?i)(?:s4key:)?/?uploads/\d+/[^\s"'<>()[\]{}]+?\.[a-z0-9]{1,12}(?:[?#][^\s"'<>()[\]{}]*)?`)
)

func extractPublicMedia(markdown string, sourceArticleID, sourceArticleTitle *string) []publicMediaReference {
	if strings.TrimSpace(markdown) == "" {
		return []publicMediaReference{}
	}
	refs := make([]publicMediaReference, 0, 8)
	seen := make(map[string]struct{})
	counters := map[string]int{"image": 0, "video": 0, "audio": 0, "file": 0}
	add := func(source, alt string) {
		ref, ok := normalizePublicMedia(source)
		if !ok {
			return
		}
		key := ref.Src
		if ref.ObjectKey != nil {
			key = *ref.ObjectKey
		}
		if _, exists := seen[key]; exists || len(refs) >= 20 {
			return
		}
		seen[key] = struct{}{}
		if strings.TrimSpace(alt) != "" {
			ref.Alt = strings.TrimSpace(alt)
		}
		counters[ref.Kind]++
		ref.ID = fmt.Sprintf("%s-%d", ref.Kind, counters[ref.Kind])
		ref.SourceArticleID = sourceArticleID
		ref.SourceArticleTitle = sourceArticleTitle
		refs = append(refs, ref)
	}
	for _, match := range publicMarkdownMediaRE.FindAllStringSubmatch(markdown, -1) {
		add(match[2], match[1])
	}
	for _, pattern := range []*regexp.Regexp{publicHTMLMediaDblRE, publicHTMLMediaSglRE, publicHTMLAnchorDblRE, publicHTMLAnchorSglRE} {
		for _, match := range pattern.FindAllStringSubmatch(markdown, -1) {
			add(match[1], "")
		}
	}
	for _, match := range publicRawStorageRE.FindAllString(markdown, -1) {
		add(match, "")
	}
	return refs
}

func normalizePublicMedia(raw string) (publicMediaReference, bool) {
	source := strings.Trim(strings.TrimSpace(raw), "<>")
	if source == "" {
		return publicMediaReference{}, false
	}
	withoutPrefix := strings.TrimPrefix(source, "s4key:")
	objectKey := strings.TrimLeft(strings.SplitN(strings.SplitN(withoutPrefix, "?", 2)[0], "#", 2)[0], "/")
	if matched, _ := regexp.MatchString(`(?i)^uploads/\d+/.+`, objectKey); matched {
		kind := classifyPublicMediaKind(objectKey)
		if kind == "" {
			kind = "file"
		}
		filename := publicMediaFilename(objectKey)
		return publicMediaReference{Kind: kind, Src: "s4key:" + objectKey, ObjectKey: &objectKey, Filename: filename, Alt: filename}, true
	}
	if strings.HasPrefix(strings.ToLower(source), "data:image/") {
		return publicMediaReference{Kind: "image", Src: source, Filename: "图片", Alt: "图片"}, true
	}
	parsed, err := url.Parse(source)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return publicMediaReference{}, false
	}
	kind := classifyPublicMediaKind(parsed.Path)
	if kind == "" {
		return publicMediaReference{}, false
	}
	filename := publicMediaFilename(parsed.Path)
	return publicMediaReference{Kind: kind, Src: source, Filename: filename, Alt: filename}, true
}

func classifyPublicMediaKind(value string) string {
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

func publicMediaFilename(value string) string {
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
