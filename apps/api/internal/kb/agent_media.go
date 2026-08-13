package kb

import (
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// AgentMediaReference 是知识读取工具返回给模型的可渲染媒体引用。
type AgentMediaReference struct {
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
	kbMarkdownMediaRE = regexp.MustCompile(`!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)`)
	kbHTMLMediaDblRE  = regexp.MustCompile(`(?i)<(?:img|video|audio|source|file)\b[^>]*\bsrc\s*=\s*"([^"]+)"[^>]*>`)
	kbHTMLMediaSglRE  = regexp.MustCompile(`(?i)<(?:img|video|audio|source|file)\b[^>]*\bsrc\s*=\s*'([^']+)'[^>]*>`)
	kbHTMLAnchorDblRE = regexp.MustCompile(`(?i)<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>`)
	kbHTMLAnchorSglRE = regexp.MustCompile(`(?i)<a\b[^>]*\bhref\s*=\s*'([^']+)'[^>]*>`)
	kbRawStorageRE    = regexp.MustCompile(`(?i)(?:s4key:)?/?uploads/\d+/[^\s"'<>()[\]{}]+?\.[a-z0-9]{1,12}(?:[?#][^\s"'<>()[\]{}]*)?`)
)

// ExtractAgentMediaReferences 从 Markdown/HTML/裸存储路径提取图片、音视频和附件。
func ExtractAgentMediaReferences(markdown string, sourceArticleID, sourceArticleTitle *string) []AgentMediaReference {
	if strings.TrimSpace(markdown) == "" {
		return []AgentMediaReference{}
	}
	refs := make([]AgentMediaReference, 0, 8)
	seen := make(map[string]struct{})
	counters := map[string]int{"image": 0, "video": 0, "audio": 0, "file": 0}
	add := func(rawSource, label string) {
		ref, ok := normalizeAgentMediaReference(rawSource)
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
		if value := strings.TrimSpace(label); value != "" {
			ref.Alt = value
		}
		counters[ref.Kind]++
		ref.ID = ref.Kind + "-" + strconv.Itoa(counters[ref.Kind])
		ref.SourceArticleID = sourceArticleID
		ref.SourceArticleTitle = sourceArticleTitle
		refs = append(refs, ref)
	}
	for _, match := range kbMarkdownMediaRE.FindAllStringSubmatch(markdown, -1) {
		add(match[2], match[1])
	}
	for _, pattern := range []*regexp.Regexp{kbHTMLMediaDblRE, kbHTMLMediaSglRE, kbHTMLAnchorDblRE, kbHTMLAnchorSglRE} {
		for _, match := range pattern.FindAllStringSubmatch(markdown, -1) {
			add(match[1], "")
		}
	}
	for _, match := range kbRawStorageRE.FindAllString(markdown, -1) {
		add(match, "")
	}
	return refs
}

func normalizeAgentMediaReference(rawSource string) (AgentMediaReference, bool) {
	source := strings.Trim(strings.TrimSpace(rawSource), "<>")
	if source == "" {
		return AgentMediaReference{}, false
	}
	withoutPrefix := strings.TrimPrefix(source, "s4key:")
	objectKey := strings.TrimLeft(strings.SplitN(strings.SplitN(withoutPrefix, "?", 2)[0], "#", 2)[0], "/")
	if matched, _ := regexp.MatchString(`(?i)^uploads/\d+/.+`, objectKey); matched {
		kind := classifyAgentMediaKind(objectKey)
		if kind == "" {
			kind = "file"
		}
		filename := agentMediaFilename(objectKey)
		return AgentMediaReference{Kind: kind, Src: "s4key:" + objectKey, ObjectKey: &objectKey, Filename: filename, Alt: filename}, true
	}
	if strings.HasPrefix(strings.ToLower(source), "data:image/") {
		return AgentMediaReference{Kind: "image", Src: source, Filename: "图片", Alt: "图片"}, true
	}
	parsed, err := url.Parse(source)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return AgentMediaReference{}, false
	}
	kind := classifyAgentMediaKind(parsed.Path)
	if kind == "" {
		return AgentMediaReference{}, false
	}
	filename := agentMediaFilename(parsed.Path)
	return AgentMediaReference{Kind: kind, Src: source, Filename: filename, Alt: filename}, true
}

func classifyAgentMediaKind(value string) string {
	switch strings.ToLower(path.Ext(strings.SplitN(strings.SplitN(value, "?", 2)[0], "#", 2)[0])) {
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
	filename := path.Base(strings.SplitN(strings.SplitN(value, "?", 2)[0], "#", 2)[0])
	if filename == "." || filename == "/" || filename == "" {
		return "附件"
	}
	if decoded, err := url.PathUnescape(filename); err == nil {
		return decoded
	}
	return filename
}

func mergeAgentMediaReferences(groups ...[]AgentMediaReference) []AgentMediaReference {
	out := make([]AgentMediaReference, 0, 20)
	seen := make(map[string]struct{})
	counters := map[string]int{"image": 0, "video": 0, "audio": 0, "file": 0}
	for _, refs := range groups {
		for _, ref := range refs {
			key := ref.Src
			if ref.ObjectKey != nil {
				key = *ref.ObjectKey
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			counters[ref.Kind]++
			ref.ID = ref.Kind + "-" + strconv.Itoa(counters[ref.Kind])
			out = append(out, ref)
			if len(out) >= 20 {
				return out
			}
		}
	}
	return out
}
