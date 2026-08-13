package publicqa

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/cloudwego/eino/components/model"
	"github.com/gin-gonic/gin"

	"github.com/Ciao1019/Petrichor/apps/api/ent"
	"github.com/Ciao1019/Petrichor/apps/api/ent/aimodelconfig"
	"github.com/Ciao1019/Petrichor/apps/api/ent/publicqaratelimit"
	"github.com/Ciao1019/Petrichor/apps/api/ent/siteappearance"
	"github.com/Ciao1019/Petrichor/apps/api/ent/user"
	"github.com/Ciao1019/Petrichor/apps/api/internal/ai"
	"github.com/Ciao1019/Petrichor/apps/api/internal/config"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/response"
	"github.com/Ciao1019/Petrichor/apps/api/internal/http/uistream"
)

const (
	visitorHourlyLimit = 10
	ipHourlyLimit      = 60
	publicQAMaxSteps   = 8
)

var visitorUUIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

type Handler struct {
	client *ent.Client
	sql    *sql.DB
	gen    *ai.Generation
}

func NewHandler(client *ent.Client, sqlDB *sql.DB, cfg *config.Config) *Handler {
	return &Handler{client: client, sql: sqlDB, gen: ai.NewGeneration(cfg)}
}

func resolveClientIP(c *gin.Context) string {
	for _, header := range []string{"X-Forwarded-For", "X-Real-Ip", "Cf-Connecting-Ip"} {
		value := strings.TrimSpace(c.GetHeader(header))
		if header == "X-Forwarded-For" {
			value = strings.TrimSpace(strings.Split(value, ",")[0])
		}
		if value != "" {
			return value
		}
	}
	return ""
}

func resolveVisitorID(c *gin.Context) string {
	value := strings.TrimSpace(c.GetHeader("X-Petrichor-Visitor-Id"))
	if !visitorUUIDPattern.MatchString(value) {
		return ""
	}
	return strings.ToLower(value)
}

func hourBucket(now time.Time) string {
	return now.UTC().Format("2006010215")
}

type publicQAQuota struct {
	Remaining int
	Limit     int
}

func (h *Handler) consumeQuota(ctx context.Context, visitorID, ip string) (publicQAQuota, error) {
	now := time.Now().UTC()
	bucket := hourBucket(now)
	ipKey := ""
	if ip != "" {
		ipKey = "ip:" + ip + ":" + bucket
	}
	primaryKey := ipKey
	if visitorID != "" {
		primaryKey = "visitor:" + visitorID + ":" + bucket
	}
	remaining := visitorHourlyLimit
	if primaryKey != "" {
		count, err := h.bumpBucket(ctx, primaryKey, now)
		if err != nil {
			return publicQAQuota{}, err
		}
		remaining = visitorHourlyLimit - count
		if remaining < 0 {
			remaining = 0
		}
		if count > visitorHourlyLimit {
			return publicQAQuota{}, response.TooManyRequests(fmt.Sprintf("本小时提问已达上限（%d 次），请稍后再试", visitorHourlyLimit))
		}
	}
	if visitorID != "" && ipKey != "" {
		count, err := h.bumpBucket(ctx, ipKey, now)
		if err != nil {
			return publicQAQuota{}, err
		}
		if count > ipHourlyLimit {
			return publicQAQuota{}, response.TooManyRequests("当前网络访问过于频繁，请稍后再试")
		}
	}
	return publicQAQuota{Remaining: remaining, Limit: visitorHourlyLimit}, nil
}

func (h *Handler) bumpBucket(ctx context.Context, bucketKey string, now time.Time) (int, error) {
	if h.sql != nil {
		var count int
		err := h.sql.QueryRowContext(ctx, `
			insert into petrichor_public_qa_rate_limit
				(bucket_key, count, window_started_at, created_at, updated_at)
			values ($1, 1, $2, $2, $2)
			on conflict (bucket_key) do update
			set count = petrichor_public_qa_rate_limit.count + 1,
				updated_at = excluded.updated_at
			returning count
		`, bucketKey, now).Scan(&count)
		return count, err
	}
	row, err := h.client.PublicQARateLimit.Query().Where(publicqaratelimit.BucketKeyEQ(bucketKey)).Only(ctx)
	if ent.IsNotFound(err) {
		_, err = h.client.PublicQARateLimit.Create().
			SetBucketKey(bucketKey).SetCount(1).SetWindowStartedAt(now).Save(ctx)
		return 1, err
	}
	if err != nil {
		return 0, err
	}
	next := row.Count + 1
	_, err = row.Update().SetCount(next).Save(ctx)
	return next, err
}

func (h *Handler) resolveOwnerAndModel(ctx context.Context) (*ent.User, *ent.AIModelConfig, model.ToolCallingChatModel, error) {
	owner, err := h.client.User.Query().
		Where(user.SystemRoleEQ("SUPER_ADMIN")).
		Order(ent.Asc(user.FieldID)).
		First(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, nil, nil, response.BadRequest("公开问答暂不可用：站点尚未初始化站长账号")
		}
		return nil, nil, nil, err
	}
	config, err := h.client.AIModelConfig.Query().
		Where(
			aimodelconfig.UserIDEQ(owner.ID), aimodelconfig.EnabledEQ(true),
			aimodelconfig.IsDefaultEQ(true), aimodelconfig.ConfigTypeEQ("CHAT"),
		).
		Order(ent.Asc(aimodelconfig.FieldID)).
		First(ctx)
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, nil, nil, response.BadRequest("公开问答暂不可用：站长未配置默认 CHAT 模型")
		}
		return nil, nil, nil, err
	}
	temperature := float32(0.2)
	chatModel, err := h.gen.NewToolCallingChatModel(ctx, config, &temperature)
	if err != nil {
		return nil, nil, nil, err
	}
	return owner, config, chatModel, nil
}

func (h *Handler) Chat(c *gin.Context) {
	ctx := c.Request.Context()
	appearance, err := h.client.SiteAppearance.Query().Where(siteappearance.IDEQ(1)).Only(ctx)
	if err != nil && !ent.IsNotFound(err) {
		response.Fail(c, err)
		return
	}
	if appearance != nil && !appearance.PublicQaEnabled {
		response.Fail(c, response.Forbidden("站长已关闭前台问答功能"))
		return
	}

	var request struct {
		Messages []publicUIMessage `json:"messages"`
	}
	if err := c.ShouldBindJSON(&request); err != nil || len(request.Messages) == 0 {
		response.Fail(c, response.BadRequest("请求参数错误"))
		return
	}

	quota, err := h.consumeQuota(ctx, resolveVisitorID(c), resolveClientIP(c))
	if err != nil {
		response.Fail(c, err)
		return
	}
	_, _, chatModel, err := h.resolveOwnerAndModel(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	scope, err := h.loadPublicArticleScope(ctx)
	if err != nil {
		response.Fail(c, err)
		return
	}
	modelMessages := publicMessagesForModel(request.Messages)
	if len(modelMessages) == 0 {
		response.Fail(c, response.BadRequest("缺少用户消息"))
		return
	}

	c.Header("X-Petrichor-Qa-Remaining", fmt.Sprintf("%d", quota.Remaining))
	c.Header("X-Petrichor-Qa-Limit", fmt.Sprintf("%d", quota.Limit))
	w := uistream.Start(c)
	if err := h.streamAnswer(ctx, chatModel, modelMessages, scope, w); err != nil {
		w.Error("公开问答暂时不可用，请稍后重试")
		return
	}
	w.Finish()
}
