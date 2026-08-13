package kb

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticle"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleburnlink"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticleshare"
	"github.com/Ciao1019/Petrichor/apps/api/ent/kbarticletag"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/upload"
)

var (
	markdownFirstImageRE = regexp.MustCompile(`!\[[^\]]*\]\(([^)\s"]+)`)
	htmlFirstImageRE     = regexp.MustCompile(`<img[^>]+src=["']([^"']+)["']`)
)

func isPublicShareVisible(share *ent.KBArticleShare, now time.Time) bool {
	if share == nil || !share.Enabled || share.RevokedAt != nil {
		return false
	}
	if share.ExpiresAt != nil && !share.ExpiresAt.After(now) {
		return false
	}
	return true
}

func resolvePublicShareStatus(share *ent.KBArticleShare, now time.Time) (listed bool, expired bool, hasPassword bool) {
	if share == nil || !share.Enabled || share.RevokedAt != nil {
		return false, false, false
	}
	hasPassword = share.PasswordHash != nil && strings.TrimSpace(*share.PasswordHash) != ""
	if share.ExpiresAt != nil && !share.ExpiresAt.After(now) {
		return false, true, hasPassword
	}
	return true, false, hasPassword
}

func buildPublicExcerpt(article *ent.KBArticle) string {
	if article.AiSummary != nil {
		if v := strings.TrimSpace(*article.AiSummary); v != "" {
			if len(v) > 200 {
				return v[:200]
			}
			return v
		}
	}
	if article.PublicExcerpt != nil {
		if v := strings.TrimSpace(*article.PublicExcerpt); v != "" {
			return v
		}
	}
	return derivePublicArticleMetadata(article.ContentMd).Excerpt
}

func resolvePublicArticleHref(shareCode string, internalURL *string) string {
	if internalURL != nil {
		v := strings.TrimSpace(*internalURL)
		if strings.HasPrefix(v, "/") {
			return v
		}
	}
	return "/p/" + shareCode
}

func resolveReadingMinutes(article *ent.KBArticle) int {
	if article.ReadingMinutes != nil && *article.ReadingMinutes > 0 {
		return *article.ReadingMinutes
	}
	words := len([]rune(article.ContentMd))
	if words == 0 {
		return 1
	}
	m := words / 400
	if m < 1 {
		return 1
	}
	return m
}

func (h *Handler) loadTagsByArticleIDs(c *gin.Context, articleIDs []int64) map[int64][]string {
	out := make(map[int64][]string)
	if len(articleIDs) == 0 {
		return out
	}
	rows, err := h.svc.client.KBArticleTag.Query().
		Where(kbarticletag.ArticleIDIn(articleIDs...)).
		Order(ent.Asc(kbarticletag.FieldTag)).
		All(c.Request.Context())
	if err != nil {
		return out
	}
	for _, row := range rows {
		out[row.ArticleID] = append(out[row.ArticleID], row.Tag)
	}
	return out
}

func (h *Handler) buildPublicListItem(share *ent.KBArticleShare, article *ent.KBArticle, tags []string, now time.Time) (gin.H, bool) {
	listed, expired, hasPassword := resolvePublicShareStatus(share, now)
	if !listed && !expired {
		return nil, false
	}
	item := gin.H{
		"articleId":      fmt.Sprintf("%d", article.ID),
		"shareCode":      share.ShareCode,
		"title":          article.Title,
		"excerpt":        buildPublicExcerpt(article),
		"updatedAt":      article.UpdatedAt.UTC().Format(time.RFC3339Nano),
		"readingMinutes": resolveReadingMinutes(article),
		"tags":           tags,
		"href":           resolvePublicArticleHref(share.ShareCode, share.InternalURL),
		"expired":        expired,
		"hasPassword":    hasPassword,
		"isRepost":       share.IsRepost,
		"isInternalLink": share.InternalURL != nil && strings.HasPrefix(strings.TrimSpace(*share.InternalURL), "/"),
		"isPinned":       share.PinOrder != nil,
	}
	if share.ExpiresAt != nil {
		item["expiresAt"] = share.ExpiresAt.UTC().Format(time.RFC3339Nano)
	} else {
		item["expiresAt"] = nil
	}
	if share.PinOrder != nil {
		item["pinOrder"] = *share.PinOrder
	} else {
		item["pinOrder"] = nil
	}
	if share.InternalURL != nil && strings.TrimSpace(*share.InternalURL) != "" {
		item["isInternalLink"] = strings.HasPrefix(strings.TrimSpace(*share.InternalURL), "/")
	}
	return item, true
}

func (h *Handler) PublicArticleList(c *gin.Context) {
	now := time.Now().UTC()
	rows, err := h.svc.client.KBArticleShare.Query().
		Where(
			kbarticleshare.EnabledEQ(true),
			kbarticleshare.RevokedAtIsNil(),
		).
		Order(ent.Desc(kbarticleshare.FieldID)).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	articleIDs := make([]int64, 0, len(rows))
	for _, share := range rows {
		articleIDs = append(articleIDs, share.ArticleID)
	}
	tagsByArticle := h.loadTagsByArticleIDs(c, articleIDs)

	type publicListEntry struct {
		item      gin.H
		pinOrder  *int
		updatedAt time.Time
		shareID   int64
	}
	entries := make([]publicListEntry, 0)
	for _, share := range rows {
		article, err := h.svc.client.KBArticle.Get(c.Request.Context(), share.ArticleID)
		if err != nil {
			continue
		}
		tags := tagsByArticle[article.ID]
		if tags == nil {
			tags = []string{}
		}
		item, ok := h.buildPublicListItem(share, article, tags, now)
		if ok {
			entries = append(entries, publicListEntry{item: item, pinOrder: share.PinOrder, updatedAt: article.UpdatedAt, shareID: share.ID})
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		left, right := entries[i], entries[j]
		if (left.pinOrder != nil) != (right.pinOrder != nil) {
			return left.pinOrder != nil
		}
		if left.pinOrder != nil && right.pinOrder != nil && *left.pinOrder != *right.pinOrder {
			return *left.pinOrder > *right.pinOrder
		}
		if !left.updatedAt.Equal(right.updatedAt) {
			return left.updatedAt.After(right.updatedAt)
		}
		return left.shareID > right.shareID
	})
	items := make([]gin.H, 0, len(entries))
	for _, entry := range entries {
		items = append(items, entry.item)
	}
	response.OK(c, gin.H{"items": items})
}

func searchKeywordFromRequest(c *gin.Context) string {
	if c.Request.Method == http.MethodGet {
		for _, key := range []string{"q", "keyword", "query"} {
			if v := strings.TrimSpace(c.Query(key)); v != "" {
				return v
			}
		}
		return ""
	}
	var req struct {
		Keyword string `json:"keyword"`
		Query   string `json:"query"`
		Q       string `json:"q"`
	}
	_ = c.ShouldBindJSON(&req)
	if v := strings.TrimSpace(req.Keyword); v != "" {
		return v
	}
	if v := strings.TrimSpace(req.Query); v != "" {
		return v
	}
	return strings.TrimSpace(req.Q)
}

func searchLimitOffset(c *gin.Context) (limit, offset int) {
	limit = 20
	offset = 0
	if c.Request.Method == http.MethodGet {
		if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 {
			limit = v
		}
		if v, err := strconv.Atoi(c.Query("offset")); err == nil && v >= 0 {
			offset = v
		}
	} else {
		var req struct {
			Limit  int `json:"limit"`
			Offset int `json:"offset"`
		}
		_ = c.ShouldBindJSON(&req)
		if req.Limit > 0 {
			limit = req.Limit
		}
		if req.Offset >= 0 {
			offset = req.Offset
		}
	}
	if limit > 50 {
		limit = 50
	}
	return limit, offset
}

func (h *Handler) PublicArticleSearch(c *gin.Context) {
	keyword := searchKeywordFromRequest(c)
	limit, offset := searchLimitOffset(c)
	if keyword == "" {
		response.OK(c, gin.H{
			"keyword": "",
			"limit":   limit,
			"offset":  offset,
			"items":   []any{},
			"hasMore": false,
		})
		return
	}
	now := time.Now().UTC()
	articles, err := h.svc.client.KBArticle.Query().
		Where(
			kbarticle.Or(
				kbarticle.TitleContainsFold(keyword),
				kbarticle.ContentMdContainsFold(keyword),
				kbarticle.AiSummaryContainsFold(keyword),
			),
		).
		Limit(limit + offset + 50).
		All(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	articleIDs := make([]int64, 0, len(articles))
	for _, a := range articles {
		articleIDs = append(articleIDs, a.ID)
	}
	tagsByArticle := h.loadTagsByArticleIDs(c, articleIDs)

	candidates := make([]gin.H, 0)
	for _, article := range articles {
		share, err := h.svc.client.KBArticleShare.Query().
			Where(kbarticleshare.ArticleIDEQ(article.ID)).
			Only(c.Request.Context())
		if err != nil || !isPublicShareVisible(share, now) {
			continue
		}
		if share.PasswordHash != nil && strings.TrimSpace(*share.PasswordHash) != "" {
			continue
		}
		tags := tagsByArticle[article.ID]
		if tags == nil {
			tags = []string{}
		}
		item, ok := h.buildPublicListItem(share, article, tags, now)
		if !ok {
			continue
		}
		score := 1.0
		if strings.Contains(strings.ToLower(article.Title), strings.ToLower(keyword)) {
			score += 4
		}
		if article.AiSummary != nil && strings.Contains(strings.ToLower(*article.AiSummary), strings.ToLower(keyword)) {
			score += 2
		}
		item["score"] = score
		candidates = append(candidates, item)
	}
	if offset >= len(candidates) {
		response.OK(c, gin.H{
			"keyword": keyword,
			"limit":   limit,
			"offset":  offset,
			"items":   []any{},
			"hasMore": false,
		})
		return
	}
	end := offset + limit
	if end > len(candidates) {
		end = len(candidates)
	}
	page := candidates[offset:end]
	hasMore := end < len(candidates)
	response.OK(c, gin.H{
		"keyword": keyword,
		"limit":   limit,
		"offset":  offset,
		"items":   page,
		"hasMore": hasMore,
	})
}

func shareDetailParams(c *gin.Context) (shareCode, password string) {
	if c.Request.Method == http.MethodGet {
		shareCode = strings.TrimSpace(c.Query("shareCode"))
		password = strings.TrimSpace(c.Query("accessPassword"))
		if password == "" {
			password = strings.TrimSpace(c.Query("password"))
		}
		return shareCode, password
	}
	var req struct {
		ShareCode      string `json:"shareCode"`
		Password       string `json:"password"`
		AccessPassword string `json:"accessPassword"`
	}
	_ = c.ShouldBindJSON(&req)
	shareCode = strings.TrimSpace(req.ShareCode)
	password = strings.TrimSpace(req.AccessPassword)
	if password == "" {
		password = strings.TrimSpace(req.Password)
	}
	return shareCode, password
}

func (h *Handler) PublicShareDetail(c *gin.Context) {
	shareCode, password := shareDetailParams(c)
	if shareCode == "" {
		response.Fail(c, response.BadRequest("缺少 shareCode"))
		return
	}
	now := time.Now().UTC()
	share, err := h.svc.client.KBArticleShare.Query().
		Where(kbarticleshare.ShareCodeEQ(shareCode)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("分享不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	if !isPublicShareVisible(share, now) {
		response.Fail(c, response.NotFound("分享不可用"))
		return
	}
	if share.PasswordHash != nil && strings.TrimSpace(*share.PasswordHash) != "" {
		if bcrypt.CompareHashAndPassword([]byte(*share.PasswordHash), []byte(password)) != nil {
			response.Fail(c, response.Forbidden("密码不正确"))
			return
		}
	}
	article, err := h.svc.client.KBArticle.Get(c.Request.Context(), share.ArticleID)
	if err != nil {
		response.Fail(c, response.NotFound("文章不存在"))
		return
	}
	tags := h.loadTagsByArticleIDs(c, []int64{article.ID})[article.ID]
	if tags == nil {
		tags = []string{}
	}
	resp := buildPublicArticleDetail(article, tags)
	isRepost := share.IsRepost && share.OriginalURL != nil && strings.TrimSpace(*share.OriginalURL) != "" && share.OriginalAuthorName != nil && strings.TrimSpace(*share.OriginalAuthorName) != ""
	resp["isRepost"] = isRepost
	resp["originalUrl"] = nil
	resp["originalAuthorName"] = nil
	if isRepost {
		resp["originalUrl"] = strings.TrimSpace(*share.OriginalURL)
		resp["originalAuthorName"] = strings.TrimSpace(*share.OriginalAuthorName)
	}
	response.OK(c, resp)
}

func buildPublicArticleDetail(article *ent.KBArticle, tags []string) gin.H {
	currentHash := BuildArticleAiSummaryContentHash(article.ContentMd)
	aiSummary := ""
	if article.AiSummary != nil {
		aiSummary = strings.TrimSpace(*article.AiSummary)
	}
	toc := buildArticleTOC(article.ContentMd)
	if article.PublicContentHash != nil && *article.PublicContentHash == currentHash && article.TocJSON != nil {
		var stored []articleTOCItem
		if json.Unmarshal([]byte(*article.TocJSON), &stored) == nil {
			toc = stored
		}
	}
	return gin.H{
		"title": article.Title, "contentMd": article.ContentMd, "contentJson": article.ContentJSON,
		"contentMetaJson": article.ContentMetaJSON, "tocJson": toc, "aiSummary": nullableTrimmed(aiSummary),
		"aiSummaryGeneratedAt": func() any {
			if aiSummary == "" {
				return nil
			}
			return formatTimePtr(article.AiSummaryGeneratedAt)
		}(),
		"aiSummaryStale": aiSummary != "" && (article.AiSummaryContentHash == nil || *article.AiSummaryContentHash != currentHash),
		"tags":           tags, "createdAt": article.CreatedAt.UTC().Format(time.RFC3339Nano),
		"updatedAt": article.UpdatedAt.UTC().Format(time.RFC3339Nano), "isRepost": false,
		"originalUrl": nil, "originalAuthorName": nil,
		"mindmapData": parseJSONValue(article.MindmapJSON), "mindmapGeneratedAt": formatTimePtr(article.MindmapGeneratedAt),
	}
}

func nullableTrimmed(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func parseJSONValue(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	var parsed any
	if json.Unmarshal([]byte(*value), &parsed) != nil {
		return nil
	}
	return parsed
}

func burnLinkCodeFromRequest(c *gin.Context) string {
	if c.Request.Method == http.MethodGet {
		for _, key := range []string{"code", "linkCode", "token"} {
			if v := strings.TrimSpace(c.Query(key)); v != "" {
				return v
			}
		}
		return ""
	}
	var req struct {
		LinkCode string `json:"linkCode"`
		Code     string `json:"code"`
		Token    string `json:"token"`
	}
	_ = c.ShouldBindJSON(&req)
	if v := strings.TrimSpace(req.Code); v != "" {
		return v
	}
	if v := strings.TrimSpace(req.LinkCode); v != "" {
		return v
	}
	return strings.TrimSpace(req.Token)
}

func burnStateFromLink(link *ent.KBArticleBurnLink, now time.Time) string {
	if link == nil {
		return "NOT_FOUND"
	}
	switch link.Status {
	case "BURNED":
		return "BURNED"
	case "REVOKED":
		return "REVOKED"
	}
	if link.ExpiresAt != nil && !link.ExpiresAt.After(now) {
		return "EXPIRED"
	}
	if link.ViewCount >= link.MaxViews {
		return "BURNED"
	}
	return "ACTIVE"
}

func (h *Handler) PublicBurnMeta(c *gin.Context) {
	linkCode := burnLinkCodeFromRequest(c)
	if linkCode == "" {
		response.Fail(c, response.BadRequest("缺少 code"))
		return
	}
	c.Header("Cache-Control", "no-store")
	now := time.Now().UTC()
	link, err := h.svc.client.KBArticleBurnLink.Query().
		Where(kbarticleburnlink.LinkCodeEQ(linkCode)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.OK(c, gin.H{
				"state":            "NOT_FOUND",
				"requiresPassword": false,
				"coverImageUrl":    nil,
			})
			return
		}
		response.Fail(c, err)
		return
	}
	state := burnStateFromLink(link, now)
	var remaining *int
	if state == "ACTIVE" {
		v := max(0, link.MaxViews-link.ViewCount)
		remaining = &v
	}
	response.OK(c, gin.H{
		"state":            state,
		"requiresPassword": link.PasswordHash != nil && strings.TrimSpace(*link.PasswordHash) != "",
		"remainingViews":   remaining,
		"coverImageUrl":    h.resolvePublicCoverImageURL(c, link, state),
	})
}

func (h *Handler) resolvePublicCoverImageURL(c *gin.Context, link *ent.KBArticleBurnLink, state string) any {
	if state != "ACTIVE" {
		return nil
	}
	article, err := h.svc.client.KBArticle.Get(c.Request.Context(), link.ArticleID)
	if err != nil {
		return nil
	}
	raw := ""
	if match := markdownFirstImageRE.FindStringSubmatch(article.ContentMd); len(match) > 1 {
		raw = match[1]
	} else if match := htmlFirstImageRE.FindStringSubmatch(article.ContentMd); len(match) > 1 {
		raw = match[1]
	}
	if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") {
		return raw
	}
	objectKey := upload.StripS4KeyPrefix(raw)
	if objectKey == "" || !strings.HasPrefix(raw, "s4key:") {
		return nil
	}
	if strings.TrimSpace(h.svc.cfg.LocalStorageDir) != "" {
		base := strings.TrimRight(h.svc.cfg.AppURL, "/")
		parts := strings.Split(objectKey, "/")
		for i := range parts {
			parts[i] = url.PathEscape(parts[i])
		}
		return base + "/api/upload/local/" + strings.Join(parts, "/")
	}
	if h.svc.cfg.S3 == nil {
		return nil
	}
	signed, err := upload.CreatePresignedURL(upload.PresignInput{
		Method: "GET", ObjectKey: objectKey, ExpiresSeconds: h.svc.cfg.S3.DownloadExpireSeconds, S3: *h.svc.cfg.S3,
	})
	if err != nil {
		return nil
	}
	return signed
}

func (h *Handler) PublicBurnConsume(c *gin.Context) {
	var req struct {
		LinkCode       string `json:"linkCode"`
		Code           string `json:"code"`
		Password       string `json:"password"`
		AccessPassword string `json:"accessPassword"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}
	linkCode := strings.TrimSpace(req.Code)
	if linkCode == "" {
		linkCode = strings.TrimSpace(req.LinkCode)
	}
	if linkCode == "" {
		response.Fail(c, response.BadRequest("缺少 code"))
		return
	}
	password := strings.TrimSpace(req.AccessPassword)
	if password == "" {
		password = strings.TrimSpace(req.Password)
	}
	c.Header("Cache-Control", "no-store")
	link, err := h.svc.client.KBArticleBurnLink.Query().
		Where(kbarticleburnlink.LinkCodeEQ(linkCode)).
		Only(c.Request.Context())
	if err != nil {
		if ent.IsNotFound(err) {
			response.Fail(c, response.NotFound("链接不存在"))
			return
		}
		response.Fail(c, err)
		return
	}
	state := burnStateFromLink(link, time.Now().UTC())
	switch state {
	case "REVOKED":
		response.Fail(c, response.Gone("该链接已被撤销"))
		return
	case "BURNED":
		response.Fail(c, response.Gone("该链接为阅后即焚，已被销毁"))
		return
	case "EXPIRED":
		response.Fail(c, response.Gone("该链接已过期"))
		return
	}
	if link.PasswordHash != nil && strings.TrimSpace(*link.PasswordHash) != "" {
		if password == "" {
			response.Fail(c, response.Forbidden("该链接需要访问密码"))
			return
		}
		if bcrypt.CompareHashAndPassword([]byte(*link.PasswordHash), []byte(password)) != nil {
			response.Fail(c, response.Forbidden("访问密码错误"))
			return
		}
	}
	updatedCount, err := h.svc.client.KBArticleBurnLink.Update().Where(
		kbarticleburnlink.IDEQ(link.ID),
		kbarticleburnlink.StatusEQ("ACTIVE"),
		kbarticleburnlink.ViewCountLT(link.MaxViews),
	).AddViewCount(1).Save(c.Request.Context())
	if err != nil {
		response.Fail(c, err)
		return
	}
	if updatedCount == 0 {
		response.Fail(c, response.Gone("该链接为阅后即焚，已被销毁"))
		return
	}
	consumed, err := h.svc.client.KBArticleBurnLink.Get(c.Request.Context(), link.ID)
	if err != nil {
		response.Fail(c, err)
		return
	}
	burned := consumed.ViewCount >= consumed.MaxViews
	if burned && consumed.Status != "BURNED" {
		now := time.Now().UTC()
		consumed, err = consumed.Update().SetStatus("BURNED").SetBurnedAt(now).Save(c.Request.Context())
		if err != nil {
			response.Fail(c, err)
			return
		}
	}
	article, err := h.svc.client.KBArticle.Get(c.Request.Context(), consumed.ArticleID)
	if err != nil {
		response.Fail(c, response.NotFound("文章不存在"))
		return
	}
	tags := h.loadTagsByArticleIDs(c, []int64{article.ID})[article.ID]
	if tags == nil {
		tags = []string{}
	}
	result := buildPublicArticleDetail(article, tags)
	result["burn"] = gin.H{"viewCount": consumed.ViewCount, "maxViews": consumed.MaxViews, "burned": burned}
	response.OK(c, result)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
