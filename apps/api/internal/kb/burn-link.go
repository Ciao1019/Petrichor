// burn-link.go 对照 burn-link-handlers.ts 的管理端点（create/list/revoke）。
package kb

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

// BurnMaxViewsLimit 单个链接允许的最大访问次数上限。1 = 严格阅后即焚。
const BurnMaxViewsLimit = 100

func requireArticleOwner(q execQuerier, userID, articleID int64) (*ArticleRow, error) {
	rows, err := q.Query(context.Background(),
		`SELECT `+articleColumns+` FROM petrichor_kb_article WHERE id = $1 LIMIT 1`, articleID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, notFoundErr("文章不存在")
	}
	article, err := scanArticleRows(rows)
	if err != nil {
		return nil, err
	}
	if article.UserID != userID {
		return nil, forbiddenErr("仅文档拥有者可执行该操作")
	}
	return article, nil
}

func parseBurnMaxViews(raw any) (int32, error) {
	if raw == nil {
		return 1, nil
	}
	text := trimSpace(toStr(raw))
	if text == "" {
		return 1, nil
	}
	value, err := strconv.Atoi(text)
	if err != nil || value < 1 || value > BurnMaxViewsLimit {
		return 0, badReq("访问次数必须在 1 到 100 之间")
	}
	return int32(value), nil
}

func buildBurnLinkResponse(link *BurnLinkRow) map[string]any {
	return map[string]any{
		"id":          strconv.FormatInt(link.ID, 10),
		"articleId":   strconv.FormatInt(link.ArticleID, 10),
		"linkCode":    link.LinkCode,
		"maxViews":    link.MaxViews,
		"viewCount":   link.ViewCount,
		"hasPassword": derefStr(link.PasswordHash) != "",
		"expiresAt":   isoPtr(link.ExpiresAt),
		"status":      link.Status,
		"burnedAt":    isoPtr(link.BurnedAt),
		"revokedAt":   isoPtr(link.RevokedAt),
		"createdAt":   iso(link.CreatedAt),
	}
}

// CreateBurnLink 新建阅后即焚链接。
func CreateBurnLink(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		articleID, err := reqID(raw["articleId"], "文章ID非法")
		if err != nil {
			return nil, err
		}
		maxViews, err := parseBurnMaxViews(raw["maxViews"])
		if err != nil {
			return nil, err
		}
		passwordEnabled := rawBool(raw, "passwordEnabled")
		accessPassword := trimSpace(rawString(raw, "accessPassword"))
		if err := validateSharePassword(accessPassword); err != nil {
			return nil, err
		}
		if passwordEnabled && accessPassword == "" {
			return nil, badReq("请填写 6 位访问密码")
		}
		expiresAt, err := parseShareExpiresAt(raw["expiresAt"])
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := requireArticleOwner(q, user.ID, articleID); err != nil {
			return nil, err
		}
		var passwordHash *string
		if passwordEnabled && accessPassword != "" {
			hash, herr := bcrypt.GenerateFromPassword([]byte(accessPassword), 10)
			if herr != nil {
				return nil, herr
			}
			s := string(hash)
			passwordHash = &s
		}
		code, cerr := generateCode()
		if cerr != nil {
			return nil, cerr
		}
		link, err := queryBurnLink(q,
			`INSERT INTO petrichor_kb_article_burn_link (user_id, article_id, link_code,
			 max_views, view_count, password_hash, expires_at, status)
			 VALUES ($1,$2,$3,$4,0,$5,$6,'ACTIVE') RETURNING `+burnLinkColumns,
			user.ID, articleID, code, maxViews, passwordHash, expiresAt)
		if err != nil {
			return nil, err
		}
		return buildBurnLinkResponse(link), nil
	})
}

func queryBurnLink(q execQuerier, sql string, args ...any) (*BurnLinkRow, error) {
	rows, err := q.Query(context.Background(), sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var r BurnLinkRow
	if err := rows.Scan(&r.ID, &r.UserID, &r.ArticleID, &r.LinkCode, &r.MaxViews, &r.ViewCount,
		&r.PasswordHash, &r.ExpiresAt, &r.Status, &r.BurnedAt, &r.RevokedAt,
		&r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, err
	}
	return &r, nil
}

// ListBurnLinks 某文章的链接列表。
func ListBurnLinks(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		articleID, err := reqID(raw["articleId"], "文章ID非法")
		if err != nil {
			return nil, err
		}
		q := pool()
		if _, err := requireArticleOwner(q, user.ID, articleID); err != nil {
			return nil, err
		}
		rows, err := q.Query(c,
			`SELECT `+burnLinkColumns+` FROM petrichor_kb_article_burn_link
			 WHERE user_id = $1 AND article_id = $2
			 ORDER BY created_at DESC, id DESC`, user.ID, articleID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var r BurnLinkRow
			if err := rows.Scan(&r.ID, &r.UserID, &r.ArticleID, &r.LinkCode, &r.MaxViews, &r.ViewCount,
				&r.PasswordHash, &r.ExpiresAt, &r.Status, &r.BurnedAt, &r.RevokedAt,
				&r.CreatedAt, &r.UpdatedAt); err != nil {
				return nil, err
			}
			items = append(items, buildBurnLinkResponse(&r))
		}
		return map[string]any{"items": items}, nil
	})
}

// RevokeBurnLink 撤销链接（幂等）。
func RevokeBurnLink(c *gin.Context) {
	run(c, func(c *gin.Context) (any, error) {
		user := currentUser(c)
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		idText := trimSpace(toStr(raw["id"]))
		if idText == "" {
			return nil, badReq("链接ID非法")
		}
		id, perr := strconv.ParseInt(idText, 10, 64)
		if perr != nil || id <= 0 {
			return nil, badReq("链接ID非法")
		}
		q := pool()
		link, err := queryBurnLink(q,
			`SELECT `+burnLinkColumns+` FROM petrichor_kb_article_burn_link
			 WHERE id = $1 AND user_id = $2 LIMIT 1`, id, user.ID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, notFoundErr("链接不存在")
			}
			return nil, err
		}
		if link.Status == "REVOKED" {
			return buildBurnLinkResponse(link), nil
		}
		now := time.Now()
		updated, err := queryBurnLink(q,
			`UPDATE petrichor_kb_article_burn_link SET status = 'REVOKED', revoked_at = $1, updated_at = $1
			 WHERE id = $2 RETURNING `+burnLinkColumns, now, link.ID)
		if err != nil {
			return nil, err
		}
		return buildBurnLinkResponse(updated), nil
	})
}
