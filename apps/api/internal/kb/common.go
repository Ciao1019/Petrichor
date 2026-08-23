// Package kb 是知识库组（52 端点）的 Go 移植，逐文件对照 apps/web/src/server/kb/*。
package kb

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	httpx "petrichor/api/internal/httpx"
)

// execQuerier 同时兼容 *pgxpool.Pool 与 pgx.Tx。
type execQuerier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func badReq(msg string) error      { return httpx.BadRequest(msg) }
func notFoundErr(msg string) error { return httpx.NotFound(msg) }
func forbiddenErr(msg string) error {
	return httpx.Forbidden(msg)
}

// ===== 注入变量 =====

// ChatRequest 统一 LLM 对话补全调用（对应 callChatCompletion）。
type ChatRequest struct {
	UserID       int64
	SystemPrompt string
	Message      string
	Op           string
}

// EmbedRequest 批量文本向量（对应 embedTexts）。
type EmbedRequest struct {
	UserID int64
	Texts  []string
	Op     string
}

// ChatInvoker LLM 对话补全注入点；nil 时涉及 LLM 的端点返回 503「AI 服务未就绪」。
var ChatInvoker func(ctx context.Context, req ChatRequest) (string, error)

// EmbedInvoker 向量生成注入点；nil 时向量端点 503，best-effort 路径静默跳过。
var EmbedInvoker func(ctx context.Context, req EmbedRequest) ([][]float32, error)

// StartImportJob 导入任务后台处理钩子（PDF 本地抽取 + 多模态 OCR 循环）。
// nil 时跳过后台调度，仅保留登记类逻辑。
var StartImportJob func(ctx context.Context, jobID int64)

func requireChat() error {
	if ChatInvoker == nil {
		return &httpx.HttpError{Status: 503, Message: "AI 服务未就绪"}
	}
	return nil
}

func requireEmbed() error {
	if EmbedInvoker == nil {
		return &httpx.HttpError{Status: 503, Message: "AI 服务未就绪"}
	}
	return nil
}

// ===== 行结构 =====

const kbColumns = `id, user_id, name, description, created_at, updated_at`

type KBRow struct {
	ID          int64
	UserID      int64
	Name        string
	Description *string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func scanKB(row pgx.Row) (*KBRow, error) {
	var r KBRow
	if err := row.Scan(&r.ID, &r.UserID, &r.Name, &r.Description, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

const nodeColumns = `id, user_id, knowledge_base_id, parent_id, type, name, sort_order, created_at, updated_at`

type NodeRow struct {
	ID              int64
	UserID          int64
	KnowledgeBaseID int64
	ParentID        *int64
	Type            string
	Name            string
	SortOrder       int32
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const articleColumns = `id, user_id, knowledge_base_id, node_id, title, content_md, content_json,
	content_meta_json, public_excerpt, reading_minutes, toc_json, public_content_hash,
	ai_summary, ai_summary_content_hash, ai_summary_generated_at,
	mindmap_json, mindmap_content_hash, mindmap_generated_at,
	mindmap_kg_json, mindmap_kg_content_hash, mindmap_kg_generated_at,
	created_at, updated_at`

type ArticleRow struct {
	ID                   int64
	UserID               int64
	KnowledgeBaseID      int64
	NodeID               int64
	Title                string
	ContentMd            string
	ContentJson          *string
	ContentMetaJson      *string
	PublicExcerpt        *string
	ReadingMinutes       *int32
	TocJson              *string
	PublicContentHash    *string
	AiSummary            *string
	AiSummaryContentHash *string
	AiSummaryGeneratedAt *time.Time
	MindmapJson          *string
	MindmapContentHash   *string
	MindmapGeneratedAt   *time.Time
	MindmapKgJson        *string
	MindmapKgContentHash *string
	MindmapKgGeneratedAt *time.Time
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

const shareColumns = `id, user_id, article_id, share_code, enabled, expires_at, password_hash,
	is_repost, original_url, original_author_name, internal_url, pin_order, revoked_at,
	created_at, updated_at`

type ShareRow struct {
	ID                 int64
	UserID             int64
	ArticleID          int64
	ShareCode          string
	Enabled            bool
	ExpiresAt          *time.Time
	PasswordHash       *string
	IsRepost           bool
	OriginalURL        *string
	OriginalAuthorName *string
	InternalURL        *string
	PinOrder           *int32
	RevokedAt          *time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

const burnLinkColumns = `id, user_id, article_id, link_code, max_views, view_count, password_hash,
	expires_at, status, burned_at, revoked_at, created_at, updated_at`

type BurnLinkRow struct {
	ID           int64
	UserID       int64
	ArticleID    int64
	LinkCode     string
	MaxViews     int32
	ViewCount    int32
	PasswordHash *string
	ExpiresAt    *time.Time
	Status       string
	BurnedAt     *time.Time
	RevokedAt    *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

const wikiPageColumns = `id, user_id, knowledge_base_id, page_key, title, kind, content_md,
	frontmatter_json, summary, content_hash, version, archived_at, created_at, updated_at`

type WikiPageRow struct {
	ID              int64
	UserID          int64
	KnowledgeBaseID int64
	PageKey         string
	Title           string
	Kind            string
	ContentMd       string
	FrontmatterJson *string
	Summary         *string
	ContentHash     string
	Version         int32
	ArchivedAt      *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const wikiPatchColumns = `id, user_id, knowledge_base_id, thread_id, run_id, page_key, title,
	operation, status, before_content_md, proposed_content_md, diff_text, reason, applied_at,
	created_at, updated_at`

type WikiPatchRow struct {
	ID                int64
	UserID            int64
	KnowledgeBaseID   int64
	ThreadID          *int64
	RunID             *int64
	PageKey           string
	Title             string
	Operation         string
	Status            string
	BeforeContentMd   *string
	ProposedContentMd string
	DiffText          string
	Reason            *string
	AppliedAt         *time.Time
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

const wikiLinkColumns = `id, user_id, knowledge_base_id, from_page_id, to_page_key, link_type, created_at`

type WikiLinkRow struct {
	ID              int64
	UserID          int64
	KnowledgeBaseID int64
	FromPageID      int64
	ToPageKey       string
	LinkType        string
	CreatedAt       time.Time
}

const sourceRefColumns = `id, page_id, article_id, anchor, quote_hash, note, created_at`

type SourceRefRow struct {
	ID        int64
	PageID    int64
	ArticleID int64
	Anchor    *string
	QuoteHash *string
	Note      *string
	CreatedAt time.Time
}

const treeNodeColumns = `id, user_id, knowledge_base_id, page_id, article_id, node_key, parent_key,
	depth, position, title, summary, content_md, start_line, end_line, token_estimate,
	content_hash, embedding_status, embedding_model, embedding_dimensions, embedding_version,
	embedding_error, embedding_updated_at, search_title_tokens, search_summary_tokens,
	search_content_tokens, created_at, updated_at`

type TreeNodeRow struct {
	ID                  int64
	UserID              int64
	KnowledgeBaseID     int64
	PageID              int64
	ArticleID           int64
	NodeKey             string
	ParentKey           *string
	Depth               int32
	Position            int32
	Title               string
	Summary             *string
	ContentMd           string
	StartLine           *int32
	EndLine             *int32
	TokenEstimate       int32
	ContentHash         string
	EmbeddingStatus     string
	EmbeddingModel      *string
	EmbeddingDimensions *int32
	EmbeddingVersion    int32
	EmbeddingError      *string
	EmbeddingUpdatedAt  *time.Time
	SearchTitleTokens   *string
	SearchSummaryTokens *string
	SearchContentTokens *string
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

const chunkColumns = `id, user_id, knowledge_base_id, article_id, chunk_key, position, heading,
	content_md, content_hash, heading_path_json, recommended_questions_json, created_at, updated_at`

type ChunkRow struct {
	ID                       int64
	UserID                   int64
	KnowledgeBaseID          int64
	ArticleID                int64
	ChunkKey                 string
	Position                 int32
	Heading                  string
	ContentMd                string
	ContentHash              string
	HeadingPathJson          string
	RecommendedQuestionsJson string
	CreatedAt                time.Time
	UpdatedAt                time.Time
}

const chunkIndexColumns = `id, user_id, knowledge_base_id, article_id, chunk_id, source_key,
	source_type, source_position, content, embedding_text, content_hash, search_tokens,
	embedding_status, embedding_model, embedding_dimensions, embedding_version, embedding_error,
	embedding_updated_at, created_at, updated_at`

type ChunkIndexRow struct {
	ID                  int64
	UserID              int64
	KnowledgeBaseID     int64
	ArticleID           int64
	ChunkID             int64
	SourceKey           string
	SourceType          string
	SourcePosition      int32
	Content             string
	EmbeddingText       string
	ContentHash         string
	SearchTokens        string
	EmbeddingStatus     string
	EmbeddingModel      *string
	EmbeddingDimensions *int32
	EmbeddingVersion    int32
	EmbeddingError      *string
	EmbeddingUpdatedAt  *time.Time
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

const jobColumns = `id, user_id, knowledge_base_id, parent_node_id, source_type, file_name,
	source_key, title, total_pages, processed_pages, status, model_config_id, article_id, error,
	created_at, updated_at`

type JobRow struct {
	ID              int64
	UserID          int64
	KnowledgeBaseID int64
	ParentNodeID    *int64
	SourceType      string
	FileName        string
	SourceKey       *string
	Title           string
	TotalPages      int32
	ProcessedPages  int32
	Status          string
	ModelConfigID   *int64
	ArticleID       *int64
	Error           *string
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

const jobPageColumns = `id, job_id, page_no, image_key, extracted_by, status, markdown, error,
	created_at, updated_at`

type JobPageRow struct {
	ID          int64
	JobID       int64
	PageNo      int32
	ImageKey    *string
	ExtractedBy string
	Status      string
	Markdown    *string
	Error       *string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

// ===== 哈希与格式化工具 =====

func sha256Hex(v string) string {
	sum := sha256.Sum256([]byte(v))
	return hex.EncodeToString(sum[:])
}

func md5Hex(v string) string {
	sum := md5.Sum([]byte(v))
	return hex.EncodeToString(sum[:])
}

// fnvHash8 对应 knowledge-build-workflow.ts 的 simpleHash（FNV-1a 32 位 → 8 位十六进制）。
func fnvHash8(value string) string {
	hash := uint32(2166136261)
	for _, r := range value {
		hash ^= uint32(r)
		hash *= 16777619
	}
	return fmtPad8(strconv.FormatUint(uint64(hash), 16))
}

func fmtPad8(s string) string {
	for len(s) < 8 {
		s = "0" + s
	}
	return s
}

func iso(t time.Time) string { return httpx.FormatISO(t) }

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return iso(*t)
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(*s)
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

func lower(s string) string { return strings.ToLower(s) }

func stringsContains(s, substr string) bool { return strings.Contains(s, substr) }

func scanArticleRows(rows interface{ Scan(dest ...any) error }) (*ArticleRow, error) {
	var r ArticleRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.NodeID, &r.Title, &r.ContentMd,
		&r.ContentJson, &r.ContentMetaJson, &r.PublicExcerpt, &r.ReadingMinutes, &r.TocJson,
		&r.PublicContentHash, &r.AiSummary, &r.AiSummaryContentHash, &r.AiSummaryGeneratedAt,
		&r.MindmapJson, &r.MindmapContentHash, &r.MindmapGeneratedAt,
		&r.MindmapKgJson, &r.MindmapKgContentHash, &r.MindmapKgGeneratedAt,
		&r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

func scanShareRows(rows interface{ Scan(dest ...any) error }) (*ShareRow, error) {
	var r ShareRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.ArticleID, &r.ShareCode, &r.Enabled, &r.ExpiresAt,
		&r.PasswordHash, &r.IsRepost, &r.OriginalURL, &r.OriginalAuthorName, &r.InternalURL,
		&r.PinOrder, &r.RevokedAt, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

func scanWikiPageRows(rows interface{ Scan(dest ...any) error }) (*WikiPageRow, error) {
	var r WikiPageRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.PageKey, &r.Title, &r.Kind,
		&r.ContentMd, &r.FrontmatterJson, &r.Summary, &r.ContentHash, &r.Version, &r.ArchivedAt,
		&r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// generateCode 对应 randomBytes(18).toString("base64url")。
func generateCode() (string, error) {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64RawURL(buf), nil
}

const base64URLChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

func base64RawURL(data []byte) string {
	var out strings.Builder
	i := 0
	for ; i+2 < len(data); i += 3 {
		n := uint32(data[i])<<16 | uint32(data[i+1])<<8 | uint32(data[i+2])
		out.WriteByte(base64URLChars[(n>>18)&63])
		out.WriteByte(base64URLChars[(n>>12)&63])
		out.WriteByte(base64URLChars[(n>>6)&63])
		out.WriteByte(base64URLChars[n&63])
	}
	rest := len(data) - i
	if rest == 1 {
		n := uint32(data[i]) << 16
		out.WriteByte(base64URLChars[(n>>18)&63])
		out.WriteByte(base64URLChars[(n>>12)&63])
	} else if rest == 2 {
		n := uint32(data[i])<<16 | uint32(data[i+1])<<8
		out.WriteByte(base64URLChars[(n>>18)&63])
		out.WriteByte(base64URLChars[(n>>12)&63])
		out.WriteByte(base64URLChars[(n>>6)&63])
	}
	return out.String()
}

// parseStringArray 解析 JSON 字符串数组列，失败或非数组返回空切片。
func parseStringArray(raw *string) []string {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return []string{}
	}
	var parsed []any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return []string{}
	}
	result := make([]string, 0, len(parsed))
	for _, item := range parsed {
		s := strings.TrimSpace(toStr(item))
		if s != "" {
			result = append(result, s)
		}
	}
	return result
}

func marshalJSON(v any) *string {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	s := string(raw)
	return &s
}

// parseJSONObject 对应 parseJsonObject：解析失败返回 nil。
func parseJSONObject(raw *string) map[string]any {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return nil
	}
	return parsed
}

func toStr(v any) string {
	switch value := v.(type) {
	case nil:
		return ""
	case string:
		return value
	case float64:
		if value == float64(int64(value)) {
			return strconv.FormatInt(int64(value), 10)
		}
		return strconv.FormatFloat(value, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(value)
	case json.Number:
		return value.String()
	default:
		return ""
	}
}

// normalizePageKey 对应 wiki-agent-logic.ts 的 normalizePageKey。
func normalizePageKey(input string) string {
	key := strings.ToLower(strings.TrimSpace(input))
	replacer := strings.NewReplacer(" ", "-", "/", "-", "\\", "-", "#", "-", "?", "-", "&", "-", "=", "-")
	key = replacer.Replace(key)
	var b strings.Builder
	lastDash := false
	for _, r := range key {
		keep := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') ||
			(r >= 0x4e00 && r <= 0x9fa5) || r == '.' || r == '_' || r == '-'
		if !keep {
			continue
		}
		if r == '-' {
			if lastDash {
				continue
			}
			lastDash = true
		} else {
			lastDash = false
		}
		b.WriteRune(r)
	}
	key = strings.Trim(b.String(), "-")
	if key == "" {
		return "page-" + sha256Hex(input)[:12]
	}
	return key
}

// summarizePlainText 对应 wiki-agent-logic.ts 的 summarizePlainText。
func summarizePlainText(markdown string, maxLength int) string {
	text := markdown
	text = fenceRe.ReplaceAllString(text, " ")
	text = inlineCode.ReplaceAllString(text, "$1")
	text = mdImageRe.ReplaceAllString(text, " ")
	text = mdLinkRe.ReplaceAllString(text, "$1")
	text = mdSymbolRe.ReplaceAllString(text, " ")
	text = spaceRe.ReplaceAllString(text, " ")
	text = strings.TrimSpace(text)
	runeCount := len([]rune(text))
	if runeCount <= maxLength {
		return text
	}
	runes := []rune(text)
	return strings.TrimRight(string(runes[:maxLength]), " \t") + "..."
}

var (
	fenceRe     = regexp.MustCompile("(?s)```.*?```")
	inlineCode  = regexp.MustCompile("`([^`]+)`")
	mdImageRe   = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLinkRe    = regexp.MustCompile(`\[[^\]]*]\(([^)]*)\)`)
	mdSymbolRe  = regexp.MustCompile("[#>*_\\-~|]")
	spaceRe     = regexp.MustCompile("\\s+")
	headingRe   = regexp.MustCompile(`^(#{1,6})\s+(.+?)\s*$`)
	fenceLineRe = regexp.MustCompile(`^\s*(` + "`" + `{3}|~{3})`)
)

// markdownToPlainText 对应 share-logic.ts 的 markdownToPlainText（摘要/阅读时长共用）。
func markdownToPlainText(contentMd string) string {
	text := fenceRe.ReplaceAllString(contentMd, " ")
	text = inlineCode.ReplaceAllString(text, "$1")
	text = mdImageRe.ReplaceAllString(text, " ")
	linkNoUrl := regexp.MustCompile(`\[([^\]]+)]\([^)]*\)`)
	text = linkNoUrl.ReplaceAllString(text, "$1")
	headStrip := regexp.MustCompile(`(?m)^#{1,6}\s+`)
	text = headStrip.ReplaceAllString(text, "")
	quoteStrip := regexp.MustCompile(`(?m)^>\s?`)
	text = quoteStrip.ReplaceAllString(text, "")
	text = mdSymbolRe.ReplaceAllString(text, " ")
	text = spaceRe.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}

// buildHomepageArticleExcerpt 对应 share-logic.ts 同名函数。
func buildHomepageArticleExcerpt(contentMd string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = 120
	}
	text := markdownToPlainText(contentMd)
	if text == "" {
		return "暂无摘要"
	}
	runes := []rune(text)
	if len(runes) <= maxLength {
		return text
	}
	return strings.TrimRight(string(runes[:maxLength]), " \t\n") + "..."
}

// estimateReadingMinutes 对应 share-logic.ts 同名函数：CJK 字符 + 拉丁词数 / 420。
func estimateReadingMinutes(contentMd string) int32 {
	text := markdownToPlainText(contentMd)
	if text == "" {
		return 1
	}
	cjkCount := 0
	for _, r := range text {
		if r >= 0x4e00 && r <= 0x9fff {
			cjkCount++
		}
	}
	stripped := regexp.MustCompile("[\\x{4e00}-\\x{9fff}]").ReplaceAllString(text, " ")
	latinWords := len(strings.Fields(stripped))
	total := cjkCount + latinWords
	minutes := (total + 419) / 420
	if minutes < 1 {
		minutes = 1
	}
	return int32(minutes)
}

// extractHeadings 提取 Markdown 标题行（围栏内忽略），返回 [级别, 标题文本]。
func extractHeadings(markdown string) [][2]string {
	var out [][2]string
	inFence := false
	for _, line := range strings.Split(markdown, "\n") {
		if fenceLineRe.MatchString(line) {
			inFence = !inFence
			continue
		}
		if inFence {
			continue
		}
		if m := headingRe.FindStringSubmatch(line); m != nil {
			out = append(out, [2]string{m[1], strings.TrimSpace(m[2])})
		}
	}
	return out
}

func sortStrings(in []string) { sort.Slice(in, func(i, j int) bool { return in[i] < in[j] }) }
