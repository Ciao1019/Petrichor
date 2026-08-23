// kb-crud.go 对照 handlers.ts 的知识库 CRUD（list/create/detail/update/delete）。
package kb

import (
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	httpx "petrichor/api/internal/httpx"
)

// run 统一出口：业务函数返回 data 即 OK 输出；data 为 nil 表示响应已直接写出
// （TableData / no-store 场景）；错误走 httpx.HandleError。
func run(c *gin.Context, fn func(c *gin.Context) (any, error)) {
	data, err := fn(c)
	if err != nil {
		httpx.HandleError(c, err)
		return
	}
	if data != nil {
		httpx.OK(c, data)
	}
}

func currentUser(c *gin.Context) *authUser { return authCurrentUser(c) }

func toKBResponse(r *KBRow) map[string]any {
	return map[string]any{
		"id":          strconv.FormatInt(r.ID, 10),
		"name":        r.Name,
		"description": r.Description,
		"createdAt":   iso(r.CreatedAt),
		"updatedAt":   iso(r.UpdatedAt),
	}
}

func scanKbRows(rows pgx.Rows) (*KBRow, error) {
	var r KBRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.Name, &r.Description, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListKnowledgeBases 列表：user 维度 + updatedAt 排序分页。
func ListKnowledgeBases(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		var input struct {
			httpx.PaginationInput
			OrderByColumn *string `json:"orderByColumn"`
		}
		if err := httpx.ReadJSON(c, &input); err != nil {
			return nil, err
		}
		q := pool()
		p := httpx.ResolvePagination(input.PaginationInput)
		order := " DESC"
		if p.Asc {
			order = " ASC"
		}

		var total int64
		if err := q.QueryRow(c,
			`SELECT COUNT(*) FROM petrichor_kb_knowledge_base WHERE user_id = $1`, user.ID).Scan(&total); err != nil {
			return nil, err
		}
		rows, err := q.Query(c,
			`SELECT `+kbColumns+` FROM petrichor_kb_knowledge_base WHERE user_id = $1
			 ORDER BY updated_at`+order+` LIMIT $2 OFFSET $3`, user.ID, p.Limit, p.Offset)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			r, err := scanKbRows(rows)
			if err != nil {
				return nil, err
			}
			items = append(items, toKBResponse(r))
		}
		httpx.TableData(c, items, total)
		return nil, nil
	})
}

// CreateKnowledgeBase 新建知识库。
func CreateKnowledgeBase(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		name := trimmedString(raw, "name")
		if name == "" || len([]rune(name)) > 120 {
			return nil, badReq("知识库名称必须在 1 到 120 个字符之间")
		}
		description, err := nullableTrimmed(raw, "description", 500)
		if err != nil {
			return nil, err
		}

		r, err := scanKB(pool().QueryRow(c,
			`INSERT INTO petrichor_kb_knowledge_base (user_id, name, description)
			 VALUES ($1, $2, $3) RETURNING `+kbColumns,
			user.ID, name, description))
		if err != nil {
			return nil, err
		}
		return toKBResponse(r), nil
	})
}

// DetailKnowledgeBase 单个详情。
func DetailKnowledgeBase(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		r, err := assertKnowledgeBaseOwner(pool(), user.ID, kbID)
		if err != nil {
			return nil, err
		}
		return toKBResponse(r), nil
	})
}

// UpdateKnowledgeBase 更新名称与描述。
func UpdateKnowledgeBase(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		kbID, err := reqID(raw["knowledgeBaseId"], "ID 必须是正整数")
		if err != nil {
			return nil, err
		}
		name := trimmedString(raw, "name")
		if name == "" || len([]rune(name)) > 120 {
			return nil, badReq("知识库名称必须在 1 到 120 个字符之间")
		}
		description, err := nullableTrimmed(raw, "description", 500)
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}
		r, err := scanKB(q.QueryRow(c,
			`UPDATE petrichor_kb_knowledge_base SET name = $1, description = $2, updated_at = now()
			 WHERE id = $3 AND user_id = $4 RETURNING `+kbColumns,
			name, description, kbID, user.ID))
		if err != nil {
			return nil, err
		}
		return toKBResponse(r), nil
	})
}

// DeleteKnowledgeBase 级联删除由数据库外键承接；公开缓存全量失效。
// TS 版还会异步清理正文里已无引用的 S4 图片对象，Go 侧对象存储清理设施未迁移，暂不执行（见交付说明）。
func DeleteKnowledgeBase(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
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
		if _, err := assertKnowledgeBaseOwner(q, user.ID, kbID); err != nil {
			return nil, err
		}
		if _, err := q.Exec(c,
			`DELETE FROM petrichor_kb_knowledge_base WHERE id = $1 AND user_id = $2`, kbID, user.ID); err != nil {
			return nil, err
		}
		invalidatePublicArticleListCache()
		invalidatePublicArticleDetailCache("")
		return map[string]any{"knowledgeBaseId": strconv.FormatInt(kbID, 10)}, nil
	})
}
