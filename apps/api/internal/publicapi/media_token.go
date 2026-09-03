package publicapi

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"petrichor/api/internal/config"
	"petrichor/api/internal/publicscope"
)

const (
	mediaKindArticle = "article"
	mediaKindBurn    = "burn"
	mediaKindWiki    = "wiki"
	mediaTokenTTL    = time.Hour
)

var errMediaAccessDenied = errors.New("媒体对象不在当前公开范围内")

type mediaAccessClaims struct {
	Kind string `json:"kind"`
	ID   int64  `json:"id"`
	Exp  int64  `json:"exp"`
}

func mediaSigningKey() []byte {
	cfg := config.Get().Encryption
	sum := sha256.Sum256([]byte(cfg.Key + "\x00" + cfg.Salt + "\x00petrichor-public-media"))
	return sum[:]
}

func issueMediaAccessToken(kind string, id int64) (string, error) {
	if id <= 0 || (kind != mediaKindArticle && kind != mediaKindBurn && kind != mediaKindWiki) {
		return "", errors.New("媒体访问范围非法")
	}
	claims := mediaAccessClaims{Kind: kind, ID: id, Exp: timeNow().Add(mediaTokenTTL).Unix()}
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, mediaSigningKey())
	_, _ = mac.Write([]byte(encoded))
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded + "." + signature, nil
}

func verifyMediaAccessToken(token string) (*mediaAccessClaims, error) {
	if len(token) == 0 || len(token) > 1024 {
		return nil, errMediaAccessDenied
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, errMediaAccessDenied
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errMediaAccessDenied
	}
	mac := hmac.New(sha256.New, mediaSigningKey())
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, errMediaAccessDenied
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errMediaAccessDenied
	}
	var claims mediaAccessClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, errMediaAccessDenied
	}
	if claims.ID <= 0 || claims.Exp <= timeNow().Unix() {
		return nil, errMediaAccessDenied
	}
	switch claims.Kind {
	case mediaKindArticle, mediaKindBurn, mediaKindWiki:
		return &claims, nil
	default:
		return nil, errMediaAccessDenied
	}
}

const objectReferencePredicate = `(strpos(a.content_md, $1) > 0
	OR strpos(COALESCE(a.content_json, ''), $1) > 0
	OR strpos(COALESCE(a.content_meta_json, ''), $1) > 0)`

func publicArticleContainsObject(ctx context.Context, objectKey string) (bool, error) {
	var allowed bool
	err := pool().QueryRow(ctx,
		`SELECT EXISTS (
		   SELECT 1
		   FROM petrichor_kb_article_share s
		   JOIN petrichor_kb_article a ON a.id = s.article_id
		   WHERE `+publicscope.ShareVisibilityWhere+` AND `+objectReferencePredicate+`
		 )`, objectKey).Scan(&allowed)
	return allowed, err
}

func safeWikiContainsObject(ctx context.Context, objectKey string) (bool, error) {
	safeIDs, err := publicscope.LoadSafeWikiPageIDs(ctx, nil)
	if err != nil || len(safeIDs) == 0 {
		return false, err
	}
	var allowed bool
	err = pool().QueryRow(ctx,
		`SELECT EXISTS (
		   SELECT 1 FROM petrichor_kb_wiki_page p
		   WHERE p.id = ANY($2) AND strpos(p.content_md, $1) > 0
		 )`, objectKey, safeIDs).Scan(&allowed)
	return allowed, err
}

func articleTokenContainsObject(ctx context.Context, articleID int64, objectKey string) (bool, error) {
	var allowed bool
	err := pool().QueryRow(ctx,
		`SELECT EXISTS (
		   SELECT 1
		   FROM petrichor_kb_article_share s
		   JOIN petrichor_kb_article a ON a.id = s.article_id
		   WHERE a.id = $2 AND s.enabled = true AND s.revoked_at IS NULL
		     AND (s.expires_at IS NULL OR s.expires_at > now())
		     AND `+objectReferencePredicate+`
		 )`, objectKey, articleID).Scan(&allowed)
	return allowed, err
}

func recordContainsObject(ctx context.Context, table, idColumn string, id int64, objectKey string) (bool, error) {
	// table/idColumn 只由包内常量调用，不接受请求输入。
	query := `SELECT EXISTS (
		SELECT 1 FROM ` + table + `
		WHERE ` + idColumn + ` = $2 AND strpos(content_md, $1) > 0
	)`
	var allowed bool
	err := pool().QueryRow(ctx, query, objectKey, id).Scan(&allowed)
	return allowed, err
}

func tokenAllowsObject(ctx context.Context, claims *mediaAccessClaims, objectKey string) (bool, error) {
	switch claims.Kind {
	case mediaKindArticle:
		return articleTokenContainsObject(ctx, claims.ID, objectKey)
	case mediaKindBurn:
		return recordContainsObject(ctx, "petrichor_kb_article", "id", claims.ID, objectKey)
	case mediaKindWiki:
		safeIDs, err := publicscope.LoadSafeWikiPageIDs(ctx, nil)
		if err != nil {
			return false, err
		}
		if _, ok := publicscope.IDSet(safeIDs)[claims.ID]; !ok {
			return false, nil
		}
		return recordContainsObject(ctx, "petrichor_kb_wiki_page", "id", claims.ID, objectKey)
	default:
		return false, errors.New("未知媒体访问范围 " + strconv.Quote(claims.Kind))
	}
}

func canReadPublicObject(ctx context.Context, objectKey, token string) (bool, error) {
	if strings.TrimSpace(token) != "" {
		claims, err := verifyMediaAccessToken(strings.TrimSpace(token))
		if err != nil {
			return false, err
		}
		return tokenAllowsObject(ctx, claims, objectKey)
	}
	allowed, err := publicArticleContainsObject(ctx, objectKey)
	if err != nil || allowed {
		return allowed, err
	}
	return safeWikiContainsObject(ctx, objectKey)
}
