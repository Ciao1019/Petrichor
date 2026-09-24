package kb

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"petrichor/api/internal/config"
	"petrichor/api/internal/httpx"
	"petrichor/api/internal/typesafe"
)

var inboxRecommendationUsers = struct {
	sync.Mutex
	active map[int64]bool
}{active: map[int64]bool{}}

func acquireInboxRecommendation(userID int64) bool {
	inboxRecommendationUsers.Lock()
	defer inboxRecommendationUsers.Unlock()
	if inboxRecommendationUsers.active[userID] || len(inboxRecommendationUsers.active) >= 8 {
		return false
	}
	inboxRecommendationUsers.active[userID] = true
	return true
}

func releaseInboxRecommendation(userID int64) {
	inboxRecommendationUsers.Lock()
	defer inboxRecommendationUsers.Unlock()
	delete(inboxRecommendationUsers.active, userID)
}

func InboxRecommendationConfig(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	cfg := config.Get().TypeSafe
	httpx.OK(c, gin.H{"enabled": cfg.Enabled && cfg.APIKey != ""})
}

// 不接受前端传入正文或候选，避免越权读取与篡改候选；整个请求只生成建议。
func RecommendInboxArchive(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	run(c, func(c *gin.Context) (any, error) {
		raw, err := readBody(c)
		if err != nil {
			return nil, err
		}
		id, err := reqID(raw["id"], "随笔 ID 无效")
		if err != nil {
			return nil, err
		}
		version, err := reqID(raw["version"], "随笔版本无效")
		if err != nil {
			return nil, err
		}
		cfg := config.Get().TypeSafe
		if !cfg.Enabled || cfg.APIKey == "" {
			return nil, &httpx.HttpError{Status: http.StatusServiceUnavailable, Message: "智能推荐尚未启用，请手动归档"}
		}
		userID := currentUser(c).ID
		if !acquireInboxRecommendation(userID) {
			return nil, httpx.TooManyRequests("智能推荐正在处理中，请稍后重试")
		}
		defer releaseInboxRecommendation(userID)
		ctx, cancel := context.WithTimeout(c.Request.Context(), time.Duration(cfg.TimeoutSeconds)*time.Second)
		defer cancel()
		q := pool()
		note, err := loadInboxNote(ctx, q, userID, id, false)
		if err != nil {
			return nil, err
		}
		if note.ArchivedAt != nil || note.Version != version {
			return nil, httpx.Conflict("随笔已归档或修改，请刷新后重新获取推荐")
		}
		bases, limited, err := loadInboxRecommendationBases(ctx, q, userID)
		if err != nil {
			return nil, err
		}
		tags, err := loadInboxRecommendationTags(ctx, q, userID)
		if err != nil {
			return nil, err
		}
		evaluate := func(ctx context.Context, state any, questions map[string]typesafe.Question) (*typesafe.Result, error) {
			return typesafe.Evaluate(ctx, cfg.BaseURL, cfg.APIKey, cfg.Model, state, questions)
		}
		out, state, err := recommendInboxBaseAndTags(ctx, evaluate, cfg, note, bases, tags, limited)
		if err != nil {
			return nil, inboxRecommendationError(err)
		}
		if out.Destination != nil {
			folders, folderLimited, loadErr := loadInboxRecommendationFolders(ctx, q, userID, out.Destination.KnowledgeBaseID)
			if loadErr != nil || recommendInboxFolder(ctx, evaluate, cfg, state, folders, folderLimited, out) != nil {
				out.Warnings = append(out.Warnings, "文件夹推荐暂时不可用，已保留知识库与标签建议，请手动选择文件夹。")
			}
		}
		// 请求期间随笔变更时不返回过期建议；归档提交仍会再次校验版本和归属。
		latest, err := loadInboxNote(c.Request.Context(), q, userID, id, false)
		if err != nil {
			return nil, err
		}
		if latest.Version != version || latest.ArchivedAt != nil {
			return nil, httpx.Conflict("随笔已归档或修改，请刷新后重新获取推荐")
		}
		out.FeedbackToken = signInboxRecommendation(userID, note, out)
		slog.Info("inbox_recommendation_generated", "userId", userID, "noteId", id, "status", out.Status, "model", out.Model, "inputTokens", out.Usage.InputTokens)
		return out, nil
	})
}

func inboxRecommendationError(err error) error {
	if errors.Is(err, typesafe.ErrRateLimited) {
		return httpx.TooManyRequests(typesafe.ErrRateLimited.Error())
	}
	message := typesafe.ErrUnavailable.Error()
	if errors.Is(err, context.DeadlineExceeded) {
		message = "智能推荐超时，请重试或手动归档"
	}
	if errors.Is(err, typesafe.ErrTooLarge) {
		message = typesafe.ErrTooLarge.Error()
	}
	if errors.Is(err, typesafe.ErrInvalid) {
		message = typesafe.ErrInvalid.Error()
	}
	return &httpx.HttpError{Status: http.StatusServiceUnavailable, Message: message}
}
