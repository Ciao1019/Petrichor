package kb

import (
	"context"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"petrichor/api/internal/auth"
	"petrichor/api/internal/cache"
	"petrichor/api/internal/db"
)

// cacheImpl 便于测试时替换的间接层。
var cacheImpl = struct {
	Drop         func(keys ...string)
	DropByPrefix func(prefix string)
}{Drop: cache.Drop, DropByPrefix: cache.DropByPrefix}

type authUser = auth.User

// ginContext 别名，减少各文件重复导入。
type ginContext = gin.Context

func authCurrentUser(c *gin.Context) *auth.User { return auth.CurrentUser(c) }

// readBody 解析 JSON 请求体为通用 map（对应 readJson + zod object 输入）。
func readBody(c *gin.Context) (map[string]any, error) {
	var raw map[string]any
	if err := c.ShouldBindJSON(&raw); err != nil {
		return nil, badReq("请求体必须是合法 JSON")
	}
	return raw, nil
}

// nullableTrimmed 读取可选字符串字段：空值 → nil；超长报错。
func nullableTrimmed(raw map[string]any, key string, maxRunes int) (*string, error) {
	v, ok := raw[key]
	if !ok || v == nil {
		return nil, nil
	}
	s := strings.TrimSpace(toStr(v))
	if s == "" {
		return nil, nil
	}
	if len([]rune(s)) > maxRunes {
		return nil, badReq(key + " 长度不能超过 " + strconv.Itoa(maxRunes))
	}
	return &s, nil
}

// OptID 兼容 string|number|null|undefined|"" 的可选正整数 ID（对应 optionalIdSchema）。
type OptID struct {
	Value int64
	Valid bool
}

func (o *OptID) UnmarshalJSON(data []byte) error {
	s := strings.TrimSpace(string(data))
	if s == "null" || s == "" {
		return nil
	}
	if unquoted, err := strconv.Unquote(s); err == nil {
		s = unquoted
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return badReq("ID 必须是正整数")
	}
	o.Value, o.Valid = n, true
	return nil
}

// reqID 必填正整数 ID（对应 idSchema / parseRequiredId）。
func reqID(raw any, message string) (int64, error) {
	var s string
	switch v := raw.(type) {
	case string:
		s = strings.TrimSpace(v)
	case float64:
		if v != float64(int64(v)) {
			return 0, badReq(message)
		}
		s = strconv.FormatInt(int64(v), 10)
	default:
		return 0, badReq(message)
	}
	if s == "" {
		return 0, badReq(message)
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 {
		return 0, badReq(message)
	}
	return n, nil
}

func trimmedString(raw map[string]any, key string) string {
	if v, ok := raw[key]; ok {
		return strings.TrimSpace(toStr(v))
	}
	return ""
}

func rawString(raw map[string]any, key string) string {
	if v, ok := raw[key]; ok && v != nil {
		return toStr(v)
	}
	return ""
}

func rawBool(raw map[string]any, key string) bool {
	v, ok := raw[key]
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && b
}

// ===== 共享断言 =====

// assertKnowledgeBaseOwner 对应 handlers.ts 同名函数：不存在即 404。
func assertKnowledgeBaseOwner(q execQuerier, userID, knowledgeBaseID int64) (*KBRow, error) {
	r, err := scanKB(q.QueryRow(context.Background(),
		`SELECT `+kbColumns+` FROM petrichor_kb_knowledge_base WHERE id = $1 AND user_id = $2 LIMIT 1`,
		knowledgeBaseID, userID))
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, notFoundErr("知识库不存在")
		}
		return nil, err
	}
	return r, nil
}

// assertNodeOwner 节点不存在即 404。
func assertNodeOwner(q execQuerier, userID, nodeID int64) (*NodeRow, error) {
	ctx := context.Background()
	rows, err := q.Query(ctx,
		`SELECT `+nodeColumns+` FROM petrichor_kb_node WHERE id = $1 AND user_id = $2 LIMIT 1`,
		nodeID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, notFoundErr("节点不存在")
	}
	var r NodeRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.KnowledgeBaseID, &r.ParentID, &r.Type, &r.Name,
		&r.SortOrder, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// assertFolderParent 父节点必须是当前知识库下的文件夹；parentId 为空时直接通过。
func assertFolderParent(q execQuerier, userID, knowledgeBaseID int64, parentID *int64) (*NodeRow, error) {
	if parentID == nil {
		return nil, nil
	}
	parent, err := assertNodeOwner(q, userID, *parentID)
	if err != nil {
		return nil, err
	}
	if parent.KnowledgeBaseID != knowledgeBaseID || parent.Type != "FOLDER" {
		return nil, badReq("父节点必须是当前知识库下的文件夹")
	}
	return parent, nil
}

// nextSortOrder 取同级最大 sort_order + 1。
func nextSortOrder(q execQuerier, userID, knowledgeBaseID int64, parentID *int64) (int32, error) {
	var sql string
	var args []any
	if parentID == nil {
		sql = `SELECT COALESCE(MAX(sort_order), 0) FROM petrichor_kb_node
			WHERE user_id = $1 AND knowledge_base_id = $2 AND parent_id IS NULL`
		args = []any{userID, knowledgeBaseID}
	} else {
		sql = `SELECT COALESCE(MAX(sort_order), 0) FROM petrichor_kb_node
			WHERE user_id = $1 AND knowledge_base_id = $2 AND parent_id = $3`
		args = []any{userID, knowledgeBaseID, *parentID}
	}
	var max int32
	if err := q.QueryRow(context.Background(), sql, args...).Scan(&max); err != nil {
		return 0, err
	}
	return max + 1, nil
}

// loadTags 按标签名排序加载文章标签。
func loadTags(q execQuerier, articleID int64) ([]string, error) {
	rows, err := q.Query(context.Background(),
		`SELECT tag FROM petrichor_kb_article_tag WHERE article_id = $1 ORDER BY tag ASC`, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tags []string
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	if tags == nil {
		tags = []string{}
	}
	return tags, rows.Err()
}

// normalizeTags 对应 share-logic.ts 的 normalizeTags（去空白、校验数量/长度、去重）。
func normalizeTags(raw []any) ([]string, error) {
	const (
		maxTagCount  = 20
		maxTagLength = 80
	)
	var tags []string
	for _, item := range raw {
		tag := strings.TrimSpace(toStr(item))
		if tag != "" {
			tags = append(tags, tag)
		}
	}
	if len(tags) > maxTagCount {
		return nil, badReq("标签数量不能超过 20")
	}
	for _, tag := range tags {
		if len([]rune(tag)) > maxTagLength {
			return nil, badReq("标签长度不能超过 80")
		}
	}
	seen := make(map[string]struct{}, len(tags))
	unique := make([]string, 0, len(tags))
	for _, tag := range tags {
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		unique = append(unique, tag)
	}
	return unique, nil
}

// replaceArticleTags 全量重建文章标签。
func replaceArticleTags(q execQuerier, articleID int64, tags []string) error {
	if _, err := q.Exec(context.Background(),
		`DELETE FROM petrichor_kb_article_tag WHERE article_id = $1`, articleID); err != nil {
		return err
	}
	for _, tag := range tags {
		if _, err := q.Exec(context.Background(),
			`INSERT INTO petrichor_kb_article_tag (article_id, tag) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`, articleID, tag); err != nil {
			return err
		}
	}
	return nil
}

// ===== 公开缓存失效（对应 public-content-cache 的 Redis 键） =====

const (
	publicArticleListCacheKey   = "petrichor:public:article-list"
	publicArticleDetailCachePre = "petrichor:public:article-detail:"
)

func invalidatePublicArticleListCache() {
	cacheImpl.Drop(publicArticleListCacheKey)
}

func invalidatePublicArticleDetailCache(shareCode string) {
	if shareCode != "" {
		cacheImpl.Drop(publicArticleDetailCachePre + shareCode)
		return
	}
	cacheImpl.DropByPrefix(publicArticleDetailCachePre)
}

// ===== 处理器骨架 =====

// pool 便捷入口。
var pool = db.Pool
