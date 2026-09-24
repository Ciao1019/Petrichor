package kb

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"slices"
	"strconv"
	"strings"
	"time"

	"petrichor/api/internal/config"
)

type inboxRecommendationReceipt struct {
	UserID    int64    `json:"user"`
	NoteID    int64    `json:"note"`
	Version   int64    `json:"version"`
	Expires   int64    `json:"expires"`
	BaseID    string   `json:"base"`
	ParentID  *string  `json:"parent"`
	Tags      []string `json:"tags"`
	Suggested bool     `json:"suggested"`
}

func inboxRecommendationMAC(payload []byte) []byte {
	mac := hmac.New(sha256.New, []byte(config.Get().Encryption.Key))
	_, _ = mac.Write([]byte("inbox-recommendation-v1\x00"))
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

// 签名只证明推荐内容，绝不授予归档权限；不新增表，通过结构化日志观察采纳情况。
func signInboxRecommendation(userID int64, note *inboxNote, out *inboxRecommendation) string {
	r := inboxRecommendationReceipt{UserID: userID, NoteID: note.ID, Version: note.Version, Expires: time.Now().Add(30 * time.Minute).Unix(), Tags: append(append([]string{}, note.Tags...), out.Tags...), Suggested: out.Destination != nil || len(out.Tags) > 0}
	if out.Destination != nil {
		r.BaseID, r.ParentID = out.Destination.KnowledgeBaseID, out.Destination.ParentID
	}
	payload, _ := json.Marshal(r)
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(inboxRecommendationMAC(payload))
}

func verifyInboxRecommendation(token string, userID, noteID, version int64) *inboxRecommendationReceipt {
	if len(token) > 16000 {
		return nil
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(signature, inboxRecommendationMAC(payload)) {
		return nil
	}
	var r inboxRecommendationReceipt
	if json.Unmarshal(payload, &r) != nil || r.UserID != userID || r.NoteID != noteID || r.Version != version || r.Expires < time.Now().Unix() {
		return nil
	}
	return &r
}

func logInboxRecommendationFeedback(userID int64, in inboxArchiveInput, note *inboxNote) {
	r := verifyInboxRecommendation(in.RecommendationToken, userID, in.NoteID, in.Version)
	if r == nil {
		return
	}
	actualTags := append([]string{}, note.Tags...)
	if in.Tags != nil {
		actualTags = append([]string{}, (*in.Tags)...)
	}
	slices.Sort(actualTags)
	slices.Sort(r.Tags)
	parent := ""
	if in.ParentID != nil {
		parent = strconv.FormatInt(*in.ParentID, 10)
	}
	expectedParent := ""
	if r.ParentID != nil {
		expectedParent = *r.ParentID
	}
	locationMatched := r.BaseID == "" || (r.BaseID == strconv.FormatInt(in.KnowledgeBaseID, 10) && parent == expectedParent)
	tagsMatched := slices.Equal(actualTags, r.Tags)
	outcome := "modified"
	if !r.Suggested {
		outcome = "no_suggestion"
	} else if locationMatched && tagsMatched {
		outcome = "accepted"
	}
	// 只在新归档事务提交后记录；日志采集端仍可按 userId/noteId/articleId 去重。
	slog.Info("inbox_recommendation_archived", "userId", userID, "noteId", in.NoteID, "articleId", nullableIDString(note.ArticleID),
		"outcome", outcome, "applied", in.RecommendationApplied, "locationMatched", locationMatched, "tagsMatched", tagsMatched)
}
